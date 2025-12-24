import { Server, Socket } from 'socket.io';
import crypto from 'crypto';

interface RoomData {
    roomId: string;
    playerA: { uid: string; socketId: string };
    playerB: { uid: string; socketId: string };
    gameReady: boolean;
    videoReady: boolean;
    expectedServices: string[];
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
    const gameServers: IceServer[] = [];
    const videoServers: IceServer[] = [...DEFAULT_STUN_SERVERS];

    // Add game TURN with ephemeral credentials if configured
    const gameTurnUrl = process.env.GAME_TURN_URL;
    const gameTurnSecret = process.env.GAME_TURN_SECRET;

    if (gameTurnUrl && gameTurnSecret && gameTurnUrl.startsWith('turn')) {
        gameServers.push(generateTurnCredentials(uid, gameTurnUrl, gameTurnSecret));
        console.log(`[ICE] Generated ephemeral game TURN credentials for ${uid}`);
    } else {
        console.warn(`[ICE] Game TURN not configured. Falling back to STUN only.`);
    }

    // Add STUN servers as backup for game
    gameServers.push(...DEFAULT_STUN_SERVERS);

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
    private uidToSocket = new Map<string, string>();

    constructor() {
        // Cleanup interval for stale rooms/sessions could go here
    }

    public registerSocket(socketId: string, uid: string) {
        console.log(`[Session] Registering socket ${socketId} for UID ${uid}`);
        this.socketToUid.set(socketId, uid);

        // Enforce 1 User = 1 Socket. Overwrite any existing socket.
        const existingSocket = this.uidToSocket.get(uid);
        if (existingSocket) {
            if (existingSocket !== socketId) {
                console.log(`[Session] User ${uid} new connection. Overwriting old socket ${existingSocket}`);
            } else {
                console.log(`[Session] User ${uid} re-registered same socket ${socketId}`);
            }
        }
        this.uidToSocket.set(uid, socketId);
        console.log(`[Session] uidToSocket set for ${uid}. Map size: ${this.uidToSocket.size}`);
    }

    public getSocketIdsForUser(uid: string): string[] {
        const socketId = this.uidToSocket.get(uid);
        if (!socketId) {
            // [DEBUG] Deep inspection on failure
            console.warn(`[Session] Lookup failed for ${uid}. Map size: ${this.uidToSocket.size}`);
            // Check if it exists with whitespace issues?
            for (const key of this.uidToSocket.keys()) {
                if (key.includes(uid) || uid.includes(key)) {
                    console.warn(`[Session] PARTIAL MATCH FOUND: '${key}' vs '${uid}' (Len: ${key.length} vs ${uid.length})`);
                }
            }
            // Optional: Dump first 5 keys to see format
            // console.log('Keys dump:', [...this.uidToSocket.keys()].slice(0,5));
        } else {
            console.log(`[Session] Lookup success for ${uid} -> ${socketId}`);
        }
        return socketId ? [socketId] : [];
    }

    public createRoom(userA: { uid: string; socketId: string }, userB: { uid: string; socketId: string }, io: Server, mode: 'random' | 'video' = 'random') {
        const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        console.log(`[Session] Creating room ${roomId} for UIDs: A=${userA.uid}, B=${userB.uid}`);
        console.log(`[Session] Input Socket IDs: A=${userA.socketId}, B=${userB.socketId}`);

        // [FIX] Validate that both users ACTUALLY have active sockets registered in SessionService
        const socketA = this.uidToSocket.get(userA.uid);
        const socketB = this.uidToSocket.get(userB.uid);

        console.log(`[Session] Fresh Socket Lookup: A=${socketA}, B=${socketB}`);

        if (!socketA || !socketB) {
            console.warn(`[Session] Aborting match ${roomId}. One or both users are no longer active.`);
            if (!socketA) console.warn(`[Session] User A (${userA.uid}) is missing socket.`);
            if (!socketB) console.warn(`[Session] User B (${userB.uid}) is missing socket.`);
            return;
        }

        if (socketA !== userA.socketId) console.warn(`[Session] User A socket changed! Queue: ${userA.socketId} -> Fresh: ${socketA}`);
        if (socketB !== userB.socketId) console.warn(`[Session] User B socket changed! Queue: ${userB.socketId} -> Fresh: ${socketB}`);

        // Use the FRESHLY looked up socket IDs
        userA.socketId = socketA;
        userB.socketId = socketB;

        const expectedServices = ['game'];
        if (mode === 'video') {
            expectedServices.push('video');
        }

        const roomData: RoomData = {
            roomId,
            playerA: userA,
            playerB: userB,
            gameReady: false,
            videoReady: false,
            expectedServices,
            createdAt: Date.now()
        };

        this.activeRooms.set(roomId, roomData);

        // Notify Player A
        io.to(userA.socketId).emit('match_found', {
            roomId,
            role: "A",
            opponentId: userB.socketId, // Send current socket for WebRTC
            opponentUid: userB.uid, // Send UID for game logic & persistence
            isInitiator: true,
            iceServers: buildIceServersForUser(userA.uid)
        });

        // Notify Player B
        io.to(userB.socketId).emit('match_found', {
            roomId,
            role: "B",
            opponentId: userA.socketId,
            opponentUid: userA.uid,
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

        // Check if all expected services are ready
        const isGameSatisfied = room.expectedServices.includes('game') ? room.gameReady : true;
        const isVideoSatisfied = room.expectedServices.includes('video') ? room.videoReady : true;

        if (isGameSatisfied && isVideoSatisfied) {
            // Access io server via socket.nsp.server or cast to any if private
            const io = (socket as any).server || (socket.nsp as any).server;
            if (io) {
                this.finalizeConnection(roomId, io);
            }
        }
    }

    // Add this method to SessionService class
    public clearSession(uid: string) {
        if (this.sessionCache.has(uid)) {
            const session = this.sessionCache.get(uid)!;
            console.log(`[Session] Clearing stale session for ${uid} (was with ${session.opponentId})`);
            this.sessionCache.delete(uid);

            // Also clear opponent's session to keep state consistent
            if (this.sessionCache.has(session.opponentId)) {
                this.sessionCache.delete(session.opponentId);
            }
        }
    }

    private finalizeConnection(roomId: string, io: Server) {
        const room = this.activeRooms.get(roomId);
        if (!room) return;

        console.log(`[Session] Room ${roomId} fully established. Caching session.`);

        // Store in Session Cache with UID reference
        // Note: opponentId here effectively stores the UID now based on usages logic
        this.sessionCache.set(room.playerA.uid, { roomId, opponentId: room.playerB.uid, role: 'A' });
        this.sessionCache.set(room.playerB.uid, { roomId, opponentId: room.playerA.uid, role: 'B' });

        // Notify clients
        [room.playerA, room.playerB].forEach(player => {
            io.to(player.socketId).emit('session_established', { roomId });
        });

        this.activeRooms.delete(roomId);
    }

    public handleDisconnect(socketId: string) {
        const uid = this.socketToUid.get(socketId);
        if (uid) {
            console.log(`[Session] Handle Disconnect: Socket ${socketId} belonged to ${uid}`);
            this.socketToUid.delete(socketId);

            const currentActiveSocket = this.uidToSocket.get(uid);
            console.log(`[Session] Current active socket for ${uid} is ${currentActiveSocket}`);

            if (currentActiveSocket === socketId) {
                this.uidToSocket.delete(uid);
                console.log(`[Session] Removed UID ${uid} from registry (Clean disconnect).`);
            } else {
                console.log(`[Session] DID NOT remove UID ${uid}. Active socket ${currentActiveSocket} != Disconnected ${socketId}`);
            }

            console.log(`[Session] User ${uid} disconnected logic complete.`);
        } else {
            console.log(`[Session] Handle Disconnect: Socket ${socketId} had no mapped UID.`);
        }
    }

    public handleReconnection(socket: Socket, uid: string) {
        let restored = false;

        // 1. Check Session Cache (Established connections)
        if (this.sessionCache.has(uid)) {
            const session = this.sessionCache.get(uid)!;
            console.log(`[Session] User ${uid} resuming active session in ${session.roomId}`);

            // [FIX] Dynamic Socket Lookup for Opponent
            // Do NOT rely on any stored socket ID. Always get fresh one.
            const opponentUid = session.opponentId; // This is actually UID in our logic
            const opponentSockets = this.getSocketIdsForUser(opponentUid);
            const opponentSocketId = opponentSockets.length > 0 ? opponentSockets[0] : null;

            socket.emit('match_found', {
                roomId: session.roomId,
                role: session.role,
                opponentId: opponentSocketId, // Send FRESH socket ID (or null if offline)
                opponentUid: opponentUid,
                isInitiator: session.role === 'A',
                iceServers: buildIceServersForUser(uid),
                isReconnection: true
            });

            // Notify Opponent that I am back (so they can update their target socket for me)
            if (opponentSocketId) {
                socket.to(opponentSocketId).emit('opponent_reconnected', {
                    message: 'Opponent is back online',
                    opponentSocketId: socket.id // Give them MY new socket ID
                });
            }

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

                    // [FIX] Dynamic Socket Lookup here too
                    const freshOpponentSockets = this.getSocketIdsForUser(opponent.uid);
                    const freshOpponentSocketId = freshOpponentSockets.length > 0 ? freshOpponentSockets[0] : null;

                    socket.emit('match_found', {
                        roomId,
                        role,
                        opponentId: freshOpponentSocketId,
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

    public getOpponentUid(uid: string): string | null {
        // 1. Check Session Cache (Established)
        if (this.sessionCache.has(uid)) {
            return this.sessionCache.get(uid)!.opponentId;
        }

        // 2. Check Active Rooms (Pending)
        // Optimization: Could store a reverse map, but activeRooms is usually small
        for (const room of this.activeRooms.values()) {
            if (room.playerA.uid === uid) return room.playerB.uid;
            if (room.playerB.uid === uid) return room.playerA.uid;
        }

        return null;
    }
}

export const sessionService = new SessionService();
