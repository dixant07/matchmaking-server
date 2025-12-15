import { Server, Socket } from 'socket.io';
import crypto from 'crypto';

interface RoomData {
    roomId: string;
    playerA: { uid: string; socketId: string };
    playerB: { uid: string; socketId: string };
    gameReady: boolean;
    videoReady: boolean;
    createdAt: number;
}

interface SessionData {
    roomId: string;
    opponentId: string; // uid of opponent
    role: 'A' | 'B';
}

// ICE Server type definitions
interface IceServer {
    urls: string;
    username?: string;
    credential?: string;
}

// Default STUN servers (always available)
const DEFAULT_STUN_SERVERS: IceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

// TTL for ephemeral credentials (24 hours)
const CREDENTIAL_TTL = 24 * 3600;

/**
 * Generate ephemeral HMAC-SHA1 credentials for TURN server
 * This is compatible with coturn's TURN REST API / ephemeral credentials
 */
const generateTurnCredentials = (uid: string, turnUrl: string, turnSecret: string): IceServer => {
    const timestamp = Math.floor(Date.now() / 1000) + CREDENTIAL_TTL;
    const username = `${timestamp}:${uid}`;

    // Generate HMAC-SHA1 signature
    const hmac = crypto.createHmac('sha1', turnSecret);
    hmac.update(username);
    const credential = hmac.digest('base64');

    return {
        urls: turnUrl,
        username: username,
        credential: credential
    };
};

/**
 * Build ICE servers configuration for a specific user
 * Generates fresh ephemeral credentials each time
 */
const buildIceServersForUser = (uid: string) => {
    const gameServers: IceServer[] = [...DEFAULT_STUN_SERVERS];
    const videoServers: IceServer[] = [...DEFAULT_STUN_SERVERS];

    // Add game TURN with ephemeral credentials if configured
    const gameTurnUrl = process.env.GAME_TURN_URL;
    const gameTurnSecret = process.env.GAME_TURN_SECRET;

    if (gameTurnUrl && gameTurnSecret && gameTurnUrl.startsWith('turn')) {
        gameServers.push(generateTurnCredentials(uid, gameTurnUrl, gameTurnSecret));
        console.log(`[ICE] Generated ephemeral game TURN credentials for ${uid}`);
    }

    // Add video TURN with ephemeral credentials if configured
    const videoTurnUrl = process.env.VIDEO_TURN_URL;
    const videoTurnSecret = process.env.VIDEO_TURN_SECRET;

    if (videoTurnUrl && videoTurnSecret && videoTurnUrl.startsWith('turn')) {
        videoServers.push(generateTurnCredentials(uid, videoTurnUrl, videoTurnSecret));
        console.log(`[ICE] Generated ephemeral video TURN credentials for ${uid}`);
    }

    return { game: gameServers, video: videoServers };
};

class SessionService {
    // Active Signaling Rooms: roomId -> RoomData
    private activeRooms = new Map<string, RoomData>();

    // Disconnected/Cached Sessions: uid -> SessionData
    private sessionCache = new Map<string, SessionData>();

    // Map socketId to uid for easy lookup on disconnect
    private socketToUid = new Map<string, string>();

    // Map uid to socketIds (one user can have multiple tabs/connections)
    private uidToSocket = new Map<string, Set<string>>();

    constructor() {
        // Cleanup interval for stale rooms/sessions could go here
    }

    public registerSocket(socketId: string, uid: string) {
        this.socketToUid.set(socketId, uid);

        if (!this.uidToSocket.has(uid)) {
            this.uidToSocket.set(uid, new Set());
        }
        this.uidToSocket.get(uid)?.add(socketId);
    }

    public getSocketIdsForUser(uid: string): string[] {
        const sockets = this.uidToSocket.get(uid);
        return sockets ? Array.from(sockets) : [];
    }

    public createRoom(userA: { uid: string; socketId: string }, userB: { uid: string; socketId: string }, io: Server) {
        const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const roomData: RoomData = {
            roomId,
            playerA: userA,
            playerB: userB,
            gameReady: false,
            videoReady: false,
            createdAt: Date.now()
        };

        this.activeRooms.set(roomId, roomData);

        // Notify Player A
        io.to(userA.socketId).emit('match_found', {
            roomId,
            role: "A",
            opponentId: userB.socketId, // socketId for WebRTC signaling
            opponentUid: userB.uid, // uid for game logic
            isInitiator: true,
            iceServers: buildIceServersForUser(userA.uid)
        });

        // Notify Player B
        io.to(userB.socketId).emit('match_found', {
            roomId,
            role: "B",
            opponentId: userA.socketId, // socketId for WebRTC signaling
            opponentUid: userA.uid, // uid for game logic
            isInitiator: false,
            iceServers: buildIceServersForUser(userB.uid)
        });

        console.log(`[Session] Created ${roomId}: ${userA.uid} vs ${userB.uid}`);
    }

    public handleConnectionStable(socket: Socket, roomId: string, service: 'game' | 'video') {
        const room = this.activeRooms.get(roomId);
        if (!room) return;

        if (service === 'game') room.gameReady = true;
        if (service === 'video') room.videoReady = true;

        console.log(`[Session] Room ${roomId}: ${service} connection stable.`);

        if (room.gameReady && room.videoReady) {
            // Access io server via socket.nsp.server or cast to any if private
            const io = (socket as any).server || (socket.nsp as any).server;
            if (io) {
                this.finalizeConnection(roomId, io);
            }
        }
    }

    private finalizeConnection(roomId: string, io: Server) {
        const room = this.activeRooms.get(roomId);
        if (!room) return;

        console.log(`[Session] Room ${roomId} fully established. Caching session.`);

        // Store in Session Cache
        this.sessionCache.set(room.playerA.uid, { roomId, opponentId: room.playerB.uid, role: 'A' });
        this.sessionCache.set(room.playerB.uid, { roomId, opponentId: room.playerA.uid, role: 'B' });

        // Notify clients
        [room.playerA, room.playerB].forEach(player => {
            io.to(player.socketId).emit('session_established', { roomId });
        });

        // We keep it in sessionCache, remove from activeRooms
        this.activeRooms.delete(roomId);
    }

    public handleDisconnect(socketId: string) {
        const uid = this.socketToUid.get(socketId);
        if (uid) {
            this.socketToUid.delete(socketId);

            const userSockets = this.uidToSocket.get(uid);
            if (userSockets) {
                userSockets.delete(socketId);
                if (userSockets.size === 0) {
                    this.uidToSocket.delete(uid);
                }
            }

            console.log(`[Session] User ${uid} disconnected.`);
        }
        // Note: We don't remove from sessionCache immediately to allow reconnection
    }

    public handleReconnection(socket: Socket, uid: string) {
        let restored = false;

        // 1. Check Session Cache (Established connections)
        if (this.sessionCache.has(uid)) {
            const session = this.sessionCache.get(uid)!;
            console.log(`[Session] User ${uid} resuming active session in ${session.roomId}`);

            socket.emit('match_found', {
                roomId: session.roomId,
                role: session.role,
                opponentId: session.opponentId,
                isInitiator: session.role === 'A',
                iceServers: buildIceServersForUser(uid),
                isReconnection: true
            });
            restored = true;
        }

        // 2. Check Active Rooms (Pending/Handshake connections)
        if (!restored) {
            for (const [roomId, room] of this.activeRooms.entries()) {
                if (room.playerA.uid === uid || room.playerB.uid === uid) {
                    console.log(`[Session] User ${uid} resuming pending handshake in ${roomId}`);

                    // Determine role
                    const isPlayerA = room.playerA.uid === uid;
                    const opponent = isPlayerA ? room.playerB : room.playerA;
                    const role = isPlayerA ? 'A' : 'B';

                    // Update socket ID if different
                    if (isPlayerA) room.playerA.socketId = socket.id;
                    else room.playerB.socketId = socket.id;
                    this.registerSocket(socket.id, uid);

                    socket.emit('match_found', {
                        roomId,
                        role,
                        opponentId: opponent.socketId,
                        opponentUid: opponent.uid,
                        isInitiator: isPlayerA,
                        iceServers: buildIceServersForUser(uid),
                        isReconnection: true
                    });
                    restored = true;
                    break;
                }
            }
        }
    }

    public hasActiveSession(uid: string): boolean {
        return this.sessionCache.has(uid);
    }

    public handleSkipMatch(socketId: string, io: Server) {
        const uid = this.socketToUid.get(socketId);
        let found = false;

        // 1. Check Session Cache (Established connections)
        if (uid && this.sessionCache.has(uid)) {
            const session = this.sessionCache.get(uid)!;
            const opponentUid = session.opponentId;
            const roomId = session.roomId;

            console.log(`[Session] Skip match requested by ${uid} for room ${roomId}`);

            // Notify all sockets for both users
            const userSockets = this.getSocketIdsForUser(uid);
            const opponentSockets = this.getSocketIdsForUser(opponentUid);

            [...userSockets, ...opponentSockets].forEach(sid => {
                io.to(sid).emit('match_skipped');
            });

            // Cleanup session cache
            this.sessionCache.delete(uid);
            this.sessionCache.delete(opponentUid);
            found = true;
        }

        // 2. Check Active Rooms (In progress of connecting)
        for (const [roomId, room] of this.activeRooms.entries()) {
            if (room.playerA.socketId === socketId || room.playerB.socketId === socketId ||
                (uid && (room.playerA.uid === uid || room.playerB.uid === uid))) {

                console.log(`[Session] Skip match requested in active room ${roomId}`);

                io.to(room.playerA.socketId).emit('match_skipped');
                io.to(room.playerB.socketId).emit('match_skipped');

                this.activeRooms.delete(roomId);
                found = true;
                break;
            }
        }

        if (!found) {
            // Force the requester to reset even if session not found server-side
            io.to(socketId).emit('match_skipped');
        }
    }

    /**
     * Get ICE servers configuration for clients
     */
    public getIceServersConfig(uid: string = 'anonymous') {
        return buildIceServersForUser(uid);
    }

    public cleanupStaleRooms(io: Server) {
        const now = Date.now();
        const TIMEOUT = 30000; // 30 seconds

        for (const [roomId, room] of this.activeRooms.entries()) {
            if (now - room.createdAt > TIMEOUT) {
                console.warn(`[Session] Room ${roomId} timed out (Stale). Cleaning up.`);

                // Notify players
                [room.playerA, room.playerB].forEach(player => {
                    const socket = io.sockets.sockets.get(player.socketId);
                    if (socket) {
                        socket.emit('match_error', { message: 'Match timed out during connection' });
                        // Optionally re-queue them or let client handle it
                    }
                });

                this.activeRooms.delete(roomId);
            }
        }
    }
}

export const sessionService = new SessionService();
