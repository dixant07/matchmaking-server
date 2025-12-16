import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

console.log('--- MATCHMAKING SERVER STARTUP ---');
console.log('Firebase Project ID (env):', process.env.FIREBASE_PROJECT_ID);

import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

import { joinQueue, removeFromQueue } from './controllers/matchController';
import { sessionService } from './services/SessionService';
import { queueService } from './services/QueueService';
import { banService } from './services/BanService';

const port = process.env.PORT || 5000;
const ADMIN_SERVER_KEY = process.env.MATCHMAKING_SERVER_KEY || 'server-secret-key';

// Socket.IO path - configurable via env or default to /socket.io
const SOCKET_PATH = process.env.SOCKET_IO_PATH || '/socket.io';

// Create HTTP server (no Express needed for pure WebSocket)
const server = http.createServer((req, res) => {
    // Simple health check endpoint - respond on both root and prefixed paths
    if (req.url === '/health' || req.url === `${SOCKET_PATH}/health`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'matchmaking', path: SOCKET_PATH }));
        return;
    }
    res.writeHead(404);
    res.end('Not Found');
});

// Socket.IO server with CORS and custom path
const io = new Server(server, {
    path: SOCKET_PATH,
    cors: {
        origin: true, // Allow any origin
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Redis Adapter for horizontal scaling
if (process.env.REDIS_URL) {
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();

    Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        console.log('[Redis] Adapter connected');
    }).catch(err => {
        console.error('[Redis] Connection error:', err);
    });
} else {
    console.log('[Redis] No REDIS_URL provided, using default in-memory adapter');
}

// Socket Authentication Middleware
io.use(async (socket: any, next) => {
    const token = socket.handshake.auth.token;
    const userId = socket.handshake.auth.userId;
    const serverKey = socket.handshake.auth.serverKey;

    // Check for admin server connection
    if (userId === 'server-admin' && serverKey === ADMIN_SERVER_KEY) {
        console.log(`[Auth] Admin server connected`);
        socket.user = { uid: 'server-admin', isAdmin: true };
        return next();
    }

    // Check for explicit userId or token
    const effectiveUid = userId || token;

    if (!effectiveUid) {
        return next(new Error('Authentication error: No token or userId provided'));
    }

    try {
        // Optimize: if it doesn't look like a JWT, treat as raw UID immediately
        if (!effectiveUid.includes('.')) {
            console.log(`[Auth] Allowing bypass for user: ${effectiveUid}`);
            socket.user = { uid: effectiveUid, email: 'guest@game.com' };
            return next();
        }

        const { auth } = await import('./config/firebase');
        const decodedToken = await auth.verifyIdToken(effectiveUid);
        socket.user = decodedToken;
        next();
    } catch (err) {
        console.warn(`[Auth] Token verification failed for ${effectiveUid}. Treating as raw UID.`);
        // Fallback: Treat as raw UID
        socket.user = { uid: effectiveUid, email: 'guest@game.com' };
        next();
    }
});

// Socket Connection Handler
io.on('connection', (socket: any) => {
    console.log(`[Socket] User connected: ${socket.id}, UID: ${socket.user?.uid || 'unknown'}`);

    // Handle disconnect
    socket.on('disconnect', async () => {
        removeFromQueue(socket.id);
        sessionService.handleDisconnect(socket.id);

        if (socket.user && socket.user.uid) {
            try {
                const { db } = await import('./config/firebase');
                const admin = await import('firebase-admin');
                await db.collection('users').doc(socket.user.uid).update({
                    isOnline: false,
                    lastActive: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (error) {
                console.error('[Socket] Error updating disconnect status:', error);
            }
        }
    });

    // Register socket with session service
    if (socket.user && socket.user.uid) {
        sessionService.registerSocket(socket.id, socket.user.uid);

        // Update online status
        (async () => {
            try {
                const { db } = await import('./config/firebase');
                const admin = await import('firebase-admin');
                await db.collection('users').doc(socket.user.uid).update({
                    isOnline: true,
                    lastActive: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (error) {
                console.error('[Socket] Error updating connect status:', error);
            }
        })();

        // Check for reconnection
        sessionService.handleReconnection(socket, socket.user.uid);
    }

    // Handle connection_stable
    socket.on('connection_stable', (data: any) => {
        const { roomId, service } = data;
        sessionService.handleConnectionStable(socket, roomId, service);
    });

    // Handle reconnect request (explicit)
    socket.on('reconnect', (data: any) => {
        if (socket.user && socket.user.uid) {
            sessionService.handleReconnection(socket, socket.user.uid);
        }
    });

    // Handle get_ice_servers request (for embedded mode)
    socket.on('get_ice_servers', () => {
        const uid = socket.user?.uid || 'anonymous';
        console.log(`[Socket] Sending ICE servers to ${socket.id} for user ${uid}`);
        const iceServers = sessionService.getIceServersConfig(uid);
        socket.emit('ice_servers_config', { iceServers });
    });

    // Handle join_queue
    socket.on('join_queue', (data: any) => joinQueue(socket, data));

    // WebRTC Signaling
    // WebRTC Signaling
    socket.on('offer', (data: any) => {
        let { offer, to, targetUid } = data;

        // Loopback Prevention
        if (targetUid === socket.user?.uid) {
            console.warn(`[Signal] Blocked self-offer from ${socket.user.uid}`);
            return;
        }

        // [FIX] Prioritize Direct Socket Routing
        // If we have the specific socket ID of the opponent (from match_found event), use it.
        // It is the most reliable way to reach the exact tab/device matched.
        if (to) {
            // console.log(`[Signal] Direct offer from ${socket.id} to ${to}`);
            io.to(to).emit('offer', { offer, from: socket.id, fromUid: socket.user.uid });
            return;
        }

        // Fallback: If no targetUid, find opponent associated with this socket's user
        if (!targetUid && socket.user?.uid) {
            targetUid = sessionService.getOpponentUid(socket.user.uid);
            if (targetUid) console.log(`[Signal] Resolved opponent UID for offer: ${targetUid}`);
        }

        if (targetUid) {
            const sockets = sessionService.getSocketIdsForUser(targetUid);
            if (sockets.length > 0) {
                console.log(`[Signal] Relaying offer from ${socket.id} to user ${targetUid}`);
                sockets.forEach(sid => {
                    io.to(sid).emit('offer', { offer, from: socket.id, fromUid: socket.user.uid });
                });
            } else {
                console.warn(`[Signal] Warning: No active sockets found for target user ${targetUid}.`);
            }
        }
    });

    socket.on('answer', (data: any) => {
        let { answer, to, targetUid } = data;

        if (targetUid === socket.user?.uid) return;

        // [FIX] Prioritize Direct Socket Routing
        if (to) {
            io.to(to).emit('answer', { answer, from: socket.id });
            return;
        }

        if (!targetUid && socket.user?.uid) {
            targetUid = sessionService.getOpponentUid(socket.user.uid);
            if (targetUid) console.log(`[Signal] Resolved opponent UID for answer: ${targetUid}`);
        }

        if (targetUid) {
            const sockets = sessionService.getSocketIdsForUser(targetUid);
            if (sockets.length > 0) {
                sockets.forEach(sid => {
                    io.to(sid).emit('answer', { answer, from: socket.id });
                });
            } else {
                console.warn(`[Signal] Warning: No active sockets found for target user ${targetUid} during answer.`);
            }
        }
    });

    socket.on('ice-candidate', (data: any) => {
        let { candidate, to, targetUid } = data;

        if (targetUid === socket.user?.uid) return;

        // [FIX] Prioritize Direct Socket Routing
        if (to) {
            io.to(to).emit('ice-candidate', { candidate, from: socket.id });
            return;
        }

        if (!targetUid && socket.user?.uid) {
            targetUid = sessionService.getOpponentUid(socket.user.uid);
        }

        if (targetUid) {
            const sockets = sessionService.getSocketIdsForUser(targetUid);
            if (sockets.length > 0) {
                sockets.forEach(sid => {
                    io.to(sid).emit('ice-candidate', { candidate, from: socket.id });
                });
            }
        }
    });

    // Video Signaling
    socket.on('video-offer', (data: any) => {
        let { offer, to, targetUid } = data; // Check if client sends targetUid for video

        if (targetUid === socket.user?.uid) return;

        // [FIX] Priority Logic: 
        // 1. If 'to' (Socket ID) is provided, use it DIRECTLY. This is the most accurate target for a new match.
        // 2. Only use 'targetUid' / 'sessionService' lookup if 'to' is missing.

        if (to) {
            // Direct socket routing (Reliable for fresh matches)
            io.to(to).emit('video-offer', { offer, from: socket.id, fromUid: socket.user.uid });
            return;
        }

        if (!targetUid && socket.user?.uid) {
            targetUid = sessionService.getOpponentUid(socket.user.uid);
        }

        if (targetUid) {
            console.log(`[Signal] Relaying video-offer from ${socket.id} to user ${targetUid}`);
            const sockets = sessionService.getSocketIdsForUser(targetUid);
            sockets.forEach(sid => {
                io.to(sid).emit('video-offer', { offer, from: socket.id, fromUid: socket.user.uid });
            });
        } else {
            console.log(`[Signal] Relaying video-offer from ${socket.id} to ${to} (Fallback)`);
            io.to(to).emit('video-offer', { offer, from: socket.id, fromUid: socket.user.uid });
        }
    });

    socket.on('video-answer', (data: any) => {
        let { answer, to, targetUid } = data;

        // If targetUid is provided (which it should be), use it to find the FRESH socket
        if (!to && targetUid) {
            const sockets = sessionService.getSocketIdsForUser(targetUid);
            sockets.forEach(sid => {
                io.to(sid).emit('video-answer', { answer, from: socket.id });
            });
            return;
        }

        if (targetUid === socket.user?.uid) return;

        if (!targetUid && socket.user?.uid) {
            targetUid = sessionService.getOpponentUid(socket.user.uid);
        }

        if (targetUid) {
            console.log(`[Signal] Relaying video-answer from ${socket.id} to user ${targetUid}`);
            const sockets = sessionService.getSocketIdsForUser(targetUid);
            sockets.forEach(sid => {
                io.to(sid).emit('video-answer', { answer, from: socket.id });
            });
        } else {
            console.log(`[Signal] Relaying video-answer from ${socket.id} to ${to} (Fallback)`);
            io.to(to).emit('video-answer', { answer, from: socket.id });
        }
    });

    socket.on('video-ice-candidate', (data: any) => {
        let { candidate, to, targetUid } = data;

        if (targetUid === socket.user?.uid) return;

        if (!targetUid && socket.user?.uid) {
            targetUid = sessionService.getOpponentUid(socket.user.uid);
        }

        if (targetUid) {
            const sockets = sessionService.getSocketIdsForUser(targetUid);
            sockets.forEach(sid => {
                io.to(sid).emit('video-ice-candidate', { candidate, from: socket.id });
            });
        } else {
            console.log(`[Signal] Relaying video-ice-candidate from ${socket.id} to ${to}`);
            io.to(to).emit('video-ice-candidate', { candidate, from: socket.id });
        }
    });

    // Friend Invite System
    socket.on('send_invite', (data: any) => {
        const { targetUid } = data;
        const targetSockets = sessionService.getSocketIdsForUser(targetUid);

        if (targetSockets.length > 0) {
            console.log(`[Invite] Sending invite from ${socket.user.uid} to ${targetUid}`);
            // Send to all of user's active sockets
            targetSockets.forEach(targetSocketId => {
                io.to(targetSocketId).emit('receive_invite', {
                    fromUid: socket.user.uid,
                    fromName: socket.user.name || 'Friend',
                    fromAvatar: socket.user.picture || ''
                });
            });
        } else {
            // User is offline or not connected
            socket.emit('invite_error', { message: 'User is undefined or offline' });
        }
    });

    socket.on('accept_invite', (data: any) => {
        const { inviterUid } = data;
        const inviterSockets = sessionService.getSocketIdsForUser(inviterUid);

        if (inviterSockets.length > 0) {
            const inviterSocketId = inviterSockets[0]; // Pick first active socket

            // Create a match immediately
            sessionService.createRoom(
                { uid: inviterUid, socketId: inviterSocketId },
                { uid: socket.user.uid, socketId: socket.id },
                io,
                'video'
            );
        } else {
            socket.emit('invite_error', { message: 'Inviter is no longer online' });
        }
    });

    socket.on('reject_invite', (data: any) => {
        const { inviterUid } = data;
        const inviterSockets = sessionService.getSocketIdsForUser(inviterUid);

        if (inviterSockets.length > 0) {
            inviterSockets.forEach(sId => {
                io.to(sId).emit('invite_rejected', { fromUid: socket.user.uid });
            });
        }
    });

    socket.on('skip_match', () => {
        sessionService.handleSkipMatch(socket.id, io);
    });

    socket.on('leave_queue', () => {
        console.log(`[Queue] User ${socket.user?.uid} manually left the queue.`);
        removeFromQueue(socket.id); // This function is already imported from matchController
    });

    // ===============================
    // Admin Commands (from REST API server)
    // ===============================

    socket.on('admin_kick_user', (data: { targetUid: string; reason?: string }) => {
        if (!socket.user?.isAdmin) {
            socket.emit('admin_action_result', { success: false, action: 'kick', message: 'Unauthorized' });
            return;
        }

        const { targetUid, reason } = data;
        const targetSockets = sessionService.getSocketIdsForUser(targetUid);

        if (targetSockets.length > 0) {
            console.log(`[Admin] Kicking user ${targetUid}. Reason: ${reason || 'No reason'}`);

            // Remove from queue
            targetSockets.forEach(sid => {
                removeFromQueue(sid);
                io.to(sid).emit('kicked', { reason: reason || 'You have been kicked by an administrator' });
            });

            // Skip any active match
            sessionService.handleSkipMatch(targetSockets[0], io);

            socket.emit('admin_action_result', { success: true, action: 'kick', message: `User ${targetUid} kicked` });
        } else {
            socket.emit('admin_action_result', { success: false, action: 'kick', message: 'User not connected' });
        }
    });

    socket.on('admin_ban_user', (data: { targetUid: string; reason: string; durationMinutes: number }) => {
        if (!socket.user?.isAdmin) {
            socket.emit('admin_action_result', { success: false, action: 'ban', message: 'Unauthorized' });
            return;
        }

        const { targetUid, reason, durationMinutes } = data;

        // Add to ban list
        banService.banUser(targetUid, reason, durationMinutes);

        // Also kick them immediately
        const targetSockets = sessionService.getSocketIdsForUser(targetUid);
        if (targetSockets.length > 0) {
            targetSockets.forEach(sid => {
                removeFromQueue(sid);
                io.to(sid).emit('banned', {
                    reason,
                    durationMinutes,
                    message: `You have been banned for ${durationMinutes > 0 ? durationMinutes + ' minutes' : 'an indefinite period'}`
                });
            });
            sessionService.handleSkipMatch(targetSockets[0], io);
        }

        socket.emit('admin_action_result', { success: true, action: 'ban', message: `User ${targetUid} banned for ${durationMinutes} minutes` });
    });

    socket.on('admin_unban_user', (data: { targetUid: string }) => {
        if (!socket.user?.isAdmin) {
            socket.emit('admin_action_result', { success: false, action: 'unban', message: 'Unauthorized' });
            return;
        }

        const { targetUid } = data;
        const result = banService.unbanUser(targetUid);

        socket.emit('admin_action_result', {
            success: result,
            action: 'unban',
            message: result ? `User ${targetUid} unbanned` : 'User was not banned'
        });
    });

    socket.on('admin_force_disconnect', (data: { targetUid: string }) => {
        if (!socket.user?.isAdmin) {
            socket.emit('admin_action_result', { success: false, action: 'disconnect', message: 'Unauthorized' });
            return;
        }

        const { targetUid } = data;
        const targetSockets = sessionService.getSocketIdsForUser(targetUid);

        if (targetSockets.length > 0) {
            console.log(`[Admin] Force disconnecting user ${targetUid}`);

            targetSockets.forEach(sid => {
                const targetSocket = io.sockets.sockets.get(sid);
                if (targetSocket) {
                    targetSocket.disconnect(true);
                }
            });

            socket.emit('admin_action_result', { success: true, action: 'disconnect', message: `User ${targetUid} disconnected` });
        } else {
            socket.emit('admin_action_result', { success: false, action: 'disconnect', message: 'User not connected' });
        }
    });
});

// Run widening check and cleanup periodically
setInterval(() => {
    queueService.processMatches(io);
    sessionService.cleanupStaleRooms(io);
}, 2000);

// Graceful shutdown handler
const gracefulShutdown = (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    server.close(() => {
        console.log('HTTP server closed.');
        io.close(() => {
            console.log('Socket.IO server closed.');
            process.exit(0);
        });
    });

    // Force close after 10 seconds
    setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server - bind to 0.0.0.0 for container compatibility
const host = '0.0.0.0';
server.listen(Number(port), host, () => {
    console.log(`🚀 Matchmaking server is running on http://${host}:${port}`);
    console.log(`[Server] Socket.IO path: ${SOCKET_PATH}`);
    console.log(`[Server] Health check available at http://${host}:${port}/health`);
});
