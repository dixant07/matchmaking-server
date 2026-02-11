import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

console.log(`[Redis] Connecting to ${redisUrl}...`);

const redisClient = createClient({
    url: redisUrl
});

redisClient.on('error', (err) => console.error('[Redis Client] Error', err));
redisClient.on('connect', () => console.log('[Redis Client] Connected'));

(async () => {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }
    } catch (err) {
        console.error('[Redis Client] Failed to connect:', err);
    }
})();

export default redisClient;
