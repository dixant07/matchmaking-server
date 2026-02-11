import redisClient from '../config/redis';

/**
 * BanService - Manages temporary bans for users in matchmaking
 * Uses Redis for persistence and automatic expiration (TTL)
 */

interface BanEntry {
    uid: string;
    reason: string;
    bannedAt: number;
    expiresAt: number; // 0 = until manually unbanned (simulating permanent)
}

class BanService {
    constructor() {
        // No cleanup interval needed; Redis handles TTL
    }

    /**
     * Ban a user for a specified duration
     * @param uid - User ID to ban
     * @param reason - Reason for the ban
     * @param durationMinutes - Duration in minutes (0 = permanent/indefinite)
     */
    public async banUser(uid: string, reason: string, durationMinutes: number = 60): Promise<void> {
        const now = Date.now();
        const expiresAt = durationMinutes > 0 ? now + (durationMinutes * 60 * 1000) : 0;
        const key = `ban:${uid}`;

        const banData: BanEntry = {
            uid,
            reason,
            bannedAt: now,
            expiresAt
        };

        // Store ban details
        await redisClient.set(key, JSON.stringify(banData));

        // Set TTL if not permanent
        if (durationMinutes > 0) {
            // Redis EXPIRE uses seconds
            await redisClient.expire(key, durationMinutes * 60);
        }

        console.log(`[Ban] User ${uid} banned for ${durationMinutes > 0 ? durationMinutes + ' minutes' : 'indefinitely'}. Reason: ${reason}`);
    }

    /**
     * Unban a user
     * @param uid - User ID to unban
     */
    public async unbanUser(uid: string): Promise<boolean> {
        const key = `ban:${uid}`;
        const result = await redisClient.del(key);

        if (result > 0) {
            console.log(`[Ban] User ${uid} unbanned`);
            return true;
        }
        return false;
    }

    /**
     * Check if a user is currently banned
     * @param uid - User ID to check
     * @returns Ban entry if banned, null otherwise
     */
    public async isBanned(uid: string): Promise<BanEntry | null> {
        const key = `ban:${uid}`;
        const data = await redisClient.get(key);

        if (!data) return null;

        try {
            return JSON.parse(data) as BanEntry;
        } catch (e) {
            console.error(`[Ban] Failed to parse ban data for ${uid}`, e);
            return null;
        }
    }

    /**
     * Get remaining ban time in milliseconds
     * @param uid - User ID to check
     * @returns Remaining time in ms, -1 if permanent, 0 if not banned
     */
    public async getRemainingBanTime(uid: string): Promise<number> {
        const key = `ban:${uid}`;

        // Check if key exists
        const exists = await redisClient.exists(key);
        if (!exists) return 0;

        // Get TTL from Redis
        const ttlSeconds = await redisClient.ttl(key);

        // TTL -1 means no expiry (permanent)
        // TTL -2 means key doesn't exist (handled by exists check usually, but safe to check)

        if (ttlSeconds === -1) return -1;
        if (ttlSeconds === -2) return 0;

        return ttlSeconds * 1000;
    }

    /**
     * Get all currently banned users
     * Note: This is an expensive operation in Redis (SCAN), use judiciously.
     * In a production environment with millions of keys, this should be avoided or paginated.
     */
    public async getBannedUsers(): Promise<BanEntry[]> {
        const bans: BanEntry[] = [];
        let cursor: any = 0; // Use any to bypass version-specific type definition mismatch (number vs string)

        try {
            do {
                const result = await redisClient.scan(cursor, { MATCH: 'ban:*', COUNT: 100 });
                cursor = result.cursor;
                const keys = result.keys;

                if (keys.length > 0) {
                    // mGet returns (string | null)[] usually
                    const values = await redisClient.mGet(keys);
                    values.forEach(val => {
                        if (val) {
                            try {
                                bans.push(JSON.parse(val));
                            } catch (e) { }
                        }
                    });
                }
            } while (cursor !== 0 && cursor !== '0');
        } catch (err) {
            console.error('[Ban] Error scanning banned users:', err);
        }

        return bans;
    }
}

export const banService = new BanService();
