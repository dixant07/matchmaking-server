# Matchmaking WebSocket Server

A standalone WebSocket server for matchmaking and WebRTC signaling, designed for deployment on DigitalOcean App Platform.

## Features

- Real-time matchmaking with queue system
- WebRTC signaling (offer/answer/ICE candidates)
- Video chat signaling
- Friend invite system
- Redis adapter support for horizontal scaling
- Firebase Authentication integration
- Admin commands for user management

## Local Development

```bash
# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env with your configuration

# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 5000, DO uses 8080) | No |
| `FIREBASE_PROJECT_ID` | Firebase project ID | Yes |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Base64-encoded Firebase service account JSON | Yes |
| `MATCHMAKING_SERVER_KEY` | Shared secret for admin server | Yes |
| `REDIS_URL` | Redis URL for horizontal scaling | No |
| `GAME_TURN_URL` | TURN server URL for game WebRTC | No |
| `GAME_TURN_SECRET` | TURN server secret for HMAC auth | No |
| `VIDEO_TURN_URL` | TURN server URL for video WebRTC | No |
| `VIDEO_TURN_SECRET` | TURN server secret for HMAC auth | No |

## Deploying to DigitalOcean App Platform

### Option 1: Via GitHub (Recommended)

1. Push your code to a GitHub repository
2. Go to DigitalOcean App Platform → Create App
3. Select your GitHub repository
4. Choose the `matchmaking` folder as the source directory
5. DigitalOcean will auto-detect the Dockerfile
6. Configure environment variables in the App settings:
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_SERVICE_ACCOUNT_KEY` (base64-encoded)
   - `MATCHMAKING_SERVER_KEY`
   - Other TURN/Redis variables as needed

### Option 2: Using doctl CLI

```bash
# Install doctl
# https://docs.digitalocean.com/reference/doctl/how-to/install/

# Authenticate
doctl auth init

# Create app from spec
doctl apps create --spec .do/app.yaml
```

### Generating Base64 Firebase Service Account Key

```bash
# On Linux/macOS:
base64 -w 0 your-service-account-key.json

# On Windows PowerShell:
[Convert]::ToBase64String([IO.File]::ReadAllBytes("your-service-account-key.json"))
```

## Health Check

The server provides a health check endpoint at `/health`:

```bash
curl http://your-server-url/health
# Response: {"status":"ok","service":"matchmaking"}
```

## WebSocket Events

### Client → Server

| Event | Description |
|-------|-------------|
| `join_queue` | Join the matchmaking queue |
| `offer` | Send WebRTC offer |
| `answer` | Send WebRTC answer |
| `ice-candidate` | Send ICE candidate |
| `video-offer` | Send video WebRTC offer |
| `video-answer` | Send video WebRTC answer |
| `video-ice-candidate` | Send video ICE candidate |
| `get_ice_servers` | Request ICE server configuration |
| `send_invite` | Send friend invite |
| `accept_invite` | Accept friend invite |
| `reject_invite` | Reject friend invite |
| `skip_match` | Skip current match |
| `connection_stable` | Report stable connection |
| `reconnect` | Request reconnection to session |

### Server → Client

| Event | Description |
|-------|-------------|
| `match_found` | Match found with opponent info |
| `offer` | Received WebRTC offer |
| `answer` | Received WebRTC answer |
| `ice-candidate` | Received ICE candidate |
| `ice_servers_config` | ICE server configuration |
| `receive_invite` | Received friend invite |
| `invite_rejected` | Friend invite was rejected |
| `kicked` | User was kicked by admin |
| `banned` | User was banned |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Web Client    │────▶│   Matchmaking   │
│  (Socket.IO)    │◀────│     Server      │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
           ┌─────────────┐           ┌─────────────┐
           │  Firebase   │           │    Redis    │
           │  (Auth/DB)  │           │  (Optional) │
           └─────────────┘           └─────────────┘
```

## License

ISC
