# Discord Stats Bot

A Discord bot for tracking team and player statistics with two teams (A-Team and B-Team).

## Features

- Track player statistics:
  - Games played
  - Goals
  - Assists
  - Saves
  - MVPs
- View player achievements based on stats
- Team leaderboards
- Admin controls for adding/removing stats
- Role-based permissions (only users with the "Scrimster" role can modify stats)
- Self-pinging mechanism to stay awake on hosting platforms like Render

## Setup Instructions

### Prerequisites

- Node.js 16 or higher
- MongoDB database (can be MongoDB Atlas)
- Discord Bot Token

### Installation

1. Clone this repository or download the files
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file with the following variables:
   ```
   DISCORD_TOKEN=your_discord_bot_token_here
   MONGODB_URI=your_mongodb_connection_string_here
   ADMIN_ROLE_NAME=Scrimster
   PORT=3000
   APP_URL=https://your-app-name.onrender.com
   ```
4. Start the bot:
   ```
   npm start
   ```

### Deploying to Render

1. Create a new Web Service on Render
2. Connect your GitHub repository
3. Configure the service:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add the environment variables from the `.env` file
5. Deploy the service

## Bot Commands

### User Commands

- `/help` - Shows help information for the bot
- `/stats [user]` - Shows stats for a user (or yourself if no user is specified)
- `/team <team>` - Shows stats for a specific team (A-Team or B-Team)
- `/leaderboard` - Shows the overall leaderboard

### Admin Commands (requires "Scrimster" role)

- `/register <user> <team>` - Register a new player to a team
- `/addstats <user> [games] [goals] [assists] [saves] [mvps]` - Add stats for a player
- `/removestats <user> [games] [goals] [assists] [saves] [mvps]` - Remove stats from a player

## License

ISC