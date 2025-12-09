/**
 * BanService - Manages temporary bans for users in matchmaking
 */

interface BanEntry {
    uid: string;
    reason: string;
    bannedAt: number;
    expiresAt: number; // 0 = until server restart
}

class BanService {
    private bannedUsers = new Map<string, BanEntry>();

    constructor() {
        // Cleanup expired bans every minute
        setInterval(() => this.cleanupExpiredBans(), 60000);
    }

    /**
     * Ban a user for a specified duration
     * @param uid - User ID to ban
     * @param reason - Reason for the ban
     * @param durationMinutes - Duration in minutes (0 = until restart)
     */
    public banUser(uid: string, reason: string, durationMinutes: number = 60): void {
        const now = Date.now();
        const expiresAt = durationMinutes > 0 ? now + (durationMinutes * 60 * 1000) : 0;

        this.bannedUsers.set(uid, {
            uid,
            reason,
            bannedAt: now,
            expiresAt
        });

        console.log(`[Ban] User ${uid} banned for ${durationMinutes > 0 ? durationMinutes + ' minutes' : 'indefinitely'}. Reason: ${reason}`);
    }

    /**
     * Unban a user
     * @param uid - User ID to unban
     */
    public unbanUser(uid: string): boolean {
        if (this.bannedUsers.has(uid)) {
            this.bannedUsers.delete(uid);
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
    public isBanned(uid: string): BanEntry | null {
        const ban = this.bannedUsers.get(uid);

        if (!ban) return null;

        // Check if ban expired
        if (ban.expiresAt > 0 && Date.now() >= ban.expiresAt) {
            this.bannedUsers.delete(uid);
            return null;
        }

        return ban;
    }

    /**
     * Get remaining ban time in milliseconds
     * @param uid - User ID to check
     * @returns Remaining time in ms, -1 if permanent, 0 if not banned
     */
    public getRemainingBanTime(uid: string): number {
        const ban = this.isBanned(uid);
        if (!ban) return 0;
        if (ban.expiresAt === 0) return -1; // Permanent
        return Math.max(0, ban.expiresAt - Date.now());
    }

    /**
     * Clean up expired bans
     */
    private cleanupExpiredBans(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const [uid, ban] of this.bannedUsers.entries()) {
            if (ban.expiresAt > 0 && now >= ban.expiresAt) {
                this.bannedUsers.delete(uid);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[Ban] Cleaned up ${cleaned} expired bans`);
        }
    }

    /**
     * Get all currently banned users
     */
    public getBannedUsers(): BanEntry[] {
        return Array.from(this.bannedUsers.values());
    }
}

export const banService = new BanService();
