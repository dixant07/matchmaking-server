import { createLogger, format, transports } from 'winston';
import redisClient from '../config/redis';

// Configure Winston Logger for structured JSON logging
// This automatically integrates with Google Cloud Logging when printed to stdout in Cloud Run
const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.json()
    ),
    defaultMeta: { service: 'matchmaking-server' },
    transports: [
        new transports.Console()
    ]
});

export class AnalyticsService {

    // --- Structured Logging (Historical / BigQuery) ---

    public logUserConnected(uid: string, socketId: string, userAgent?: string) {
        logger.info('user_connected', {
            event: 'user_connected',
            uid,
            socketId,
            userAgent,
            timestamp: new Date().toISOString()
        });
    }

    public logUserDisconnected(uid: string, durationSeconds: number) {
        logger.info('user_disconnected', {
            event: 'user_disconnected',
            uid,
            durationSeconds,
            timestamp: new Date().toISOString()
        });
    }

    public logMatchStart(matchId: string, users: string[], mode: string, isBotMatch: boolean) {
        logger.info('match_start', {
            event: 'match_start',
            matchId,
            users,
            mode,
            isBotMatch,
            timestamp: new Date().toISOString()
        });
    }

    public logMatchEnd(matchId: string, durationSeconds: number, reason: string, isBotMatch: boolean) {
        logger.info('match_end', {
            event: 'match_end',
            matchId,
            durationSeconds,
            reason, // e.g., 'disconnect', 'skip', 'game_over'
            isBotMatch,
            timestamp: new Date().toISOString()
        });
    }

    public logGameAction(matchId: string, uid: string, action: string, metadata: any = {}) {
        logger.info('game_action', {
            event: 'game_action',
            matchId,
            uid,
            action,
            ...metadata,
            timestamp: new Date().toISOString()
        });
    }

    // --- Real-Time Stats (Redis) ---

    /**
     * Fetch real-time counters from Redis.
     * Useful for admin dashboards or /stats endpoint.
     */
    public async getRealTimeStats() {
        try {
            const [
                onlineUsersCount,
                queueMale,
                queueFemale
            ] = await Promise.all([
                redisClient.sCard('users:online'),
                redisClient.zCard('queue:male'),
                redisClient.zCard('queue:female')
            ]);

            return {
                online_users: onlineUsersCount || 0,
                queues: {
                    male: queueMale || 0,
                    female: queueFemale || 0,
                    total_pending: (queueMale || 0) + (queueFemale || 0)
                },
                timestamp: new Date()
            };
        } catch (error) {
            logger.error('Error fetching realtime stats', { error });
            return null;
        }
    }
}

export const analyticsService = new AnalyticsService();
