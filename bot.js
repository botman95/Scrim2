// Discord Stats Bot for tracking team statistics
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, MessageFlags, AttachmentBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const PORT = process.env.PORT || 3000;

// Try to load environment variables from .env file if dotenv is available
try {
    require('dotenv').config();
} catch (error) {
    console.log('dotenv module not found, skipping .env file loading');
}

// Bot configuration
const config = {
    adminRoleName: process.env.ADMIN_ROLE_NAME || 'Scrimster', // Admin role name
    teams: {
        a: 'A-Team',
        b: 'B-Team'
    },
    colors: {
        primary: '#3498db',
        success: '#2ecc71',
        error: '#e74c3c',
        aTeam: '#ff5555',
        bTeam: '#5555ff'
    },
    dataFilePath: path.join(__dirname, 'players.json'),
    teamStatsFilePath: path.join(__dirname, 'team-stats.json'),
    gameHistoryFilePath: path.join(__dirname, 'game-history.json'),
    scheduledMatchesFilePath: path.join(__dirname, 'scheduled-matches.json'),
    backupsFolder: path.join(__dirname, 'backups')
};

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ],
    // Better connection options
    restRequestTimeout: 60000,
    restGlobalRateLimit: 50,
    retryLimit: Infinity,
    ws: {
        large_threshold: 50
    }
});

// Database utility functions using file storage
const db = {
    // Read entire players file
    readPlayersFile: async () => {
        try {
            // Ensure the file exists, create if not
            await fs.access(config.dataFilePath).catch(async () => {
                await fs.writeFile(config.dataFilePath, JSON.stringify([]));
            });

            const data = await fs.readFile(config.dataFilePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading players file:', error);
            return [];
        }
    },

    // Write players data to file
    writePlayersFile: async (players) => {
        try {
            await fs.writeFile(config.dataFilePath, JSON.stringify(players, null, 2));
        } catch (error) {
            console.error('Error writing players file:', error);
        }
    },

    // Read team stats file
    readTeamStatsFile: async () => {
        try {
            // Ensure the file exists, create if not
            await fs.access(config.teamStatsFilePath).catch(async () => {
                const defaultTeamStats = {
                    'A-Team': { wins: 0, losses: 0 },
                    'B-Team': { wins: 0, losses: 0 }
                };
                await fs.writeFile(config.teamStatsFilePath, JSON.stringify(defaultTeamStats, null, 2));
            });

            const data = await fs.readFile(config.teamStatsFilePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading team stats file:', error);
            return {
                'A-Team': { wins: 0, losses: 0 },
                'B-Team': { wins: 0, losses: 0 }
            };
        }
    },

    // Write team stats data to file
    writeTeamStatsFile: async (teamStats) => {
        try {
            await fs.writeFile(config.teamStatsFilePath, JSON.stringify(teamStats, null, 2));
        } catch (error) {
            console.error('Error writing team stats file:', error);
        }
    },

    // Get team stats
    getTeamStats: async (teamName) => {
        const teamStats = await db.readTeamStatsFile();
        return teamStats[teamName] || { wins: 0, losses: 0 };
    },

    // Update team stats (add wins/losses)
    updateTeamStats: async (teamName, wins = 0, losses = 0) => {
        const teamStats = await db.readTeamStatsFile();
        
        if (!teamStats[teamName]) {
            teamStats[teamName] = { wins: 0, losses: 0 };
        }
        
        teamStats[teamName].wins += wins;
        teamStats[teamName].losses += losses;
        
        // Ensure no negative values
        teamStats[teamName].wins = Math.max(0, teamStats[teamName].wins);
        teamStats[teamName].losses = Math.max(0, teamStats[teamName].losses);
        
        await db.writeTeamStatsFile(teamStats);
        return teamStats[teamName];
    },

    // Remove team stats (supports negative values for removal)
    removeTeamStats: async (teamName, wins = 0, losses = 0) => {
        const teamStats = await db.readTeamStatsFile();
        
        if (!teamStats[teamName]) {
            teamStats[teamName] = { wins: 0, losses: 0 };
        }
        
        teamStats[teamName].wins -= wins;
        teamStats[teamName].losses -= losses;
        
        // Ensure no negative values
        teamStats[teamName].wins = Math.max(0, teamStats[teamName].wins);
        teamStats[teamName].losses = Math.max(0, teamStats[teamName].losses);
        
        await db.writeTeamStatsFile(teamStats);
        return teamStats[teamName];
    },

    // Get a specific player
    getPlayer: async (discordId) => {
        const players = await db.readPlayersFile();
        return players.find(p => p.discordId === discordId);
    },

    // Get all players (optionally filtered by team)
    getAllPlayers: async (team = null) => {
        const players = await db.readPlayersFile();
        return team 
            ? players.filter(p => p.team === team).sort((a, b) => b.goals - a.goals)
            : players.sort((a, b) => b.goals - a.goals);
    },

    // Create a new player - Updated to include shots but remove demos
    createPlayer: async (discordId, displayName, team) => {
        const players = await db.readPlayersFile();
        
        // Check if player already exists
        if (players.some(p => p.discordId === discordId)) {
            throw new Error('Player already exists');
        }

        const newPlayer = {
            discordId,
            displayName,
            team,
            gamesPlayed: 0,
            goals: 0,
            assists: 0,
            saves: 0,
            mvps: 0,
            shots: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        players.push(newPlayer);
        await db.writePlayersFile(players);
        return newPlayer;
    },

    // Update player stats
    updatePlayerStats: async (discordId, stats) => {
        const players = await db.readPlayersFile();
        const playerIndex = players.findIndex(p => p.discordId === discordId);
        
        if (playerIndex === -1) {
            throw new Error('Player not found');
        }
        
        // Update stats
        const player = players[playerIndex];
        Object.keys(stats).forEach(stat => {
            if (player.hasOwnProperty(stat) && typeof player[stat] === 'number') {
                player[stat] += stats[stat];
            }
        });
        
        // Update timestamp
        player.updatedAt = new Date().toISOString();
        
        // Write updated players back to file
        await db.writePlayersFile(players);
        return player;
    },
    
    // Remove player stats
    removePlayerStats: async (discordId, stats) => {
        const players = await db.readPlayersFile();
        const playerIndex = players.findIndex(p => p.discordId === discordId);
        
        if (playerIndex === -1) {
            throw new Error('Player not found');
        }
        
        // Remove stats
        const player = players[playerIndex];
        Object.keys(stats).forEach(stat => {
            if (player.hasOwnProperty(stat) && typeof player[stat] === 'number') {
                player[stat] = Math.max(0, player[stat] - stats[stat]);
            }
        });
        
        // Update timestamp
        player.updatedAt = new Date().toISOString();
        
        // Write updated players back to file
        await db.writePlayersFile(players);
        return player;
    },
    
    // Update player name
    updatePlayerName: async (discordId, displayName) => {
        const players = await db.readPlayersFile();
        const playerIndex = players.findIndex(p => p.discordId === discordId);
        
        if (playerIndex === -1) {
            throw new Error('Player not found');
        }
        
        // Update display name
        players[playerIndex].displayName = displayName;
        players[playerIndex].updatedAt = new Date().toISOString();
        
        // Write updated players back to file
        await db.writePlayersFile(players);
        return players[playerIndex];
    },

    // Game History Functions
    readGameHistoryFile: async () => {
        try {
            await fs.access(config.gameHistoryFilePath).catch(async () => {
                await fs.writeFile(config.gameHistoryFilePath, JSON.stringify([]));
            });

            const data = await fs.readFile(config.gameHistoryFilePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading game history file:', error);
            return [];
        }
    },

    writeGameHistoryFile: async (gameHistory) => {
        try {
            await fs.writeFile(config.gameHistoryFilePath, JSON.stringify(gameHistory, null, 2));
        } catch (error) {
            console.error('Error writing game history file:', error);
        }
    },

    // Add game record for recent form tracking
    addGameRecord: async (discordId, gameStats) => {
        const gameHistory = await db.readGameHistoryFile();
        const gameRecord = {
            discordId,
            timestamp: new Date().toISOString(),
            ...gameStats
        };
        
        gameHistory.push(gameRecord);
        await db.writeGameHistoryFile(gameHistory);
        return gameRecord;
    },

    // Get recent games for a player (last N games)
    getRecentGames: async (discordId, limit = 10) => {
        const gameHistory = await db.readGameHistoryFile();
        return gameHistory
            .filter(game => game.discordId === discordId)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, limit);
    },

    // Scheduled Matches Functions
    readScheduledMatchesFile: async () => {
        try {
            await fs.access(config.scheduledMatchesFilePath).catch(async () => {
                await fs.writeFile(config.scheduledMatchesFilePath, JSON.stringify([]));
            });

            const data = await fs.readFile(config.scheduledMatchesFilePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading scheduled matches file:', error);
            return [];
        }
    },

    writeScheduledMatchesFile: async (matches) => {
        try {
            await fs.writeFile(config.scheduledMatchesFilePath, JSON.stringify(matches, null, 2));
        } catch (error) {
            console.error('Error writing scheduled matches file:', error);
        }
    },

    // Schedule a match
    scheduleMatch: async (team1, team2, dateTime, description = '') => {
        const matches = await db.readScheduledMatchesFile();
        const matchId = Date.now().toString();
        
        const newMatch = {
            id: matchId,
            team1,
            team2,
            dateTime,
            description,
            createdAt: new Date().toISOString(),
            notified: false
        };
        
        matches.push(newMatch);
        await db.writeScheduledMatchesFile(matches);
        return newMatch;
    },

    // Get upcoming matches
    getUpcomingMatches: async (limit = 5) => {
        const matches = await db.readScheduledMatchesFile();
        const now = new Date();
        
        return matches
            .filter(match => new Date(match.dateTime) > now)
            .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime))
            .slice(0, limit);
    },

    // Remove expired matches
    cleanupOldMatches: async () => {
        const matches = await db.readScheduledMatchesFile();
        const now = new Date();
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        const activeMatches = matches.filter(match => new Date(match.dateTime) > dayAgo);
        await db.writeScheduledMatchesFile(activeMatches);
        return activeMatches.length;
    },

    // Find matches by criteria
    findMatches: async (teams = null, dateStr = null) => {
        const matches = await db.readScheduledMatchesFile();
        const now = new Date();
        
        // Filter out past matches
        let filteredMatches = matches.filter(match => new Date(match.dateTime) > now);
        
        // Filter by teams if provided
        if (teams) {
            const teamsLower = teams.toLowerCase();
            filteredMatches = filteredMatches.filter(match => {
                const matchStr = `${match.team1} vs ${match.team2}`.toLowerCase();
                return matchStr.includes(teamsLower) || 
                       match.team1.toLowerCase().includes(teamsLower) || 
                       match.team2.toLowerCase().includes(teamsLower);
            });
        }
        
        // Filter by date if provided
        if (dateStr) {
            const targetDate = new Date(dateStr);
            if (!isNaN(targetDate.getTime())) {
                filteredMatches = filteredMatches.filter(match => {
                    const matchDate = new Date(match.dateTime);
                    return matchDate.toDateString() === targetDate.toDateString();
                });
            }
        }
        
        return filteredMatches.sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
    },

    // Cancel a specific match by ID
    cancelMatch: async (matchId) => {
        const matches = await db.readScheduledMatchesFile();
        const matchIndex = matches.findIndex(match => match.id === matchId);
        
        if (matchIndex === -1) {
            throw new Error('Match not found');
        }
        
        const cancelledMatch = matches[matchIndex];
        matches.splice(matchIndex, 1);
        await db.writeScheduledMatchesFile(matches);
        return cancelledMatch;
    },

    // Backup System Functions
    createBackup: async (backupType = 'manual') => {
        try {
            // Ensure backups folder exists
            await fs.mkdir(config.backupsFolder, { recursive: true });
            
            // Create timestamp for backup
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const backupFolder = path.join(config.backupsFolder, `backup-${timestamp}-${backupType}`);
            
            await fs.mkdir(backupFolder, { recursive: true });
            
            // Backup all data files
            const filesToBackup = [
                { src: config.dataFilePath, name: 'players.json' },
                { src: config.teamStatsFilePath, name: 'team-stats.json' },
                { src: config.gameHistoryFilePath, name: 'game-history.json' },
                { src: config.scheduledMatchesFilePath, name: 'scheduled-matches.json' }
            ];
            
            let filesBackedUp = 0;
            for (const file of filesToBackup) {
                try {
                    await fs.access(file.src);
                    const destPath = path.join(backupFolder, file.name);
                    await fs.copyFile(file.src, destPath);
                    filesBackedUp++;
                } catch (error) {
                    console.log(`File ${file.name} not found, skipping...`);
                }
            }
            
            // Create backup manifest
            const manifest = {
                timestamp: new Date().toISOString(),
                type: backupType,
                filesBackedUp,
                version: '1.0'
            };
            
            await fs.writeFile(
                path.join(backupFolder, 'backup-manifest.json'), 
                JSON.stringify(manifest, null, 2)
            );
            
            console.log(`✅ Backup created: ${backupFolder}`);
            return { folder: backupFolder, manifest };
            
        } catch (error) {
            console.error('❌ Error creating backup:', error);
            throw new Error(`Backup failed: ${error.message}`);
        }
    },

    listBackups: async () => {
        try {
            await fs.mkdir(config.backupsFolder, { recursive: true });
            const backupDirs = await fs.readdir(config.backupsFolder);
            
            const backups = [];
            for (const dir of backupDirs) {
                if (dir.startsWith('backup-')) {
                    const manifestPath = path.join(config.backupsFolder, dir, 'backup-manifest.json');
                    try {
                        const manifestData = await fs.readFile(manifestPath, 'utf8');
                        const manifest = JSON.parse(manifestData);
                        backups.push({
                            folder: dir,
                            ...manifest
                        });
                    } catch (error) {
                        // Skip backups without valid manifest
                        console.warn(`Invalid backup folder: ${dir}`);
                    }
                }
            }
            
            return backups.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
        } catch (error) {
            console.error('Error listing backups:', error);
            return [];
        }
    },

    restoreFromBackup: async (backupFolder) => {
        try {
            const backupPath = path.join(config.backupsFolder, backupFolder);
            
            // Check if backup exists
            await fs.access(backupPath);
            
            // Restore each file
            const filesToRestore = [
                { name: 'players.json', dest: config.dataFilePath },
                { name: 'team-stats.json', dest: config.teamStatsFilePath },
                { name: 'game-history.json', dest: config.gameHistoryFilePath },
                { name: 'scheduled-matches.json', dest: config.scheduledMatchesFilePath }
            ];
            
            let filesRestored = 0;
            for (const file of filesToRestore) {
                const srcPath = path.join(backupPath, file.name);
                try {
                    await fs.access(srcPath);
                    await fs.copyFile(srcPath, file.dest);
                    filesRestored++;
                } catch (error) {
                    console.log(`Backup file ${file.name} not found, skipping...`);
                }
            }
            
            console.log(`✅ Restored ${filesRestored} files from backup: ${backupFolder}`);
            return filesRestored;
            
        } catch (error) {
            console.error('❌ Error restoring backup:', error);
            throw new Error(`Restore failed: ${error.message}`);
        }
    },

    cleanupOldBackups: async (keepDays = 30) => {
        try {
            const backups = await db.listBackups();
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - keepDays);
            
            let deletedCount = 0;
            for (const backup of backups) {
                const backupDate = new Date(backup.timestamp);
                if (backupDate < cutoffDate) {
                    const backupPath = path.join(config.backupsFolder, backup.folder);
                    await fs.rmdir(backupPath, { recursive: true });
                    deletedCount++;
                }
            }
            
            if (deletedCount > 0) {
                console.log(`🧹 Cleaned up ${deletedCount} old backups`);
            }
            
            return deletedCount;
            
        } catch (error) {
            console.error('Error cleaning up backups:', error);
            return 0;
        }
    }
};

// Achievements definition (updated to remove demos)
const ACHIEVEMENTS = {
    goals: [
        { threshold: 10, name: 'Sniper', emoji: '🎯', description: 'Score 10+ goals' },
        { threshold: 25, name: 'Sharp Shooter', emoji: '🚀', description: 'Score 25+ goals' },
        { threshold: 50, name: 'Goal Machine', emoji: '💯', description: 'Score 50+ goals' },
        { threshold: 100, name: 'Legend', emoji: '🔥', description: 'Score 100+ goals' }
    ],
    assists: [
        { threshold: 10, name: 'Playmaker', emoji: '👟', description: 'Get 10+ assists' },
        { threshold: 25, name: 'Master Tactician', emoji: '🧠', description: 'Get 25+ assists' },
        { threshold: 50, name: 'Assist King', emoji: '👑', description: 'Get 50+ assists' }
    ],
    saves: [
        { threshold: 15, name: 'Safe Hands', emoji: '🧤', description: 'Make 15+ saves' },
        { threshold: 30, name: 'Wall', emoji: '🛡️', description: 'Make 30+ saves' },
        { threshold: 75, name: 'Guardian', emoji: '🏰', description: 'Make 75+ saves' }
    ],
    shots: [
        { threshold: 50, name: 'Trigger Happy', emoji: '🎯', description: 'Take 50+ shots' },
        { threshold: 100, name: 'Shot Caller', emoji: '🚀', description: 'Take 100+ shots' },
        { threshold: 250, name: 'Sharpshooter', emoji: '🏹', description: 'Take 250+ shots' }
    ],
    mvps: [
        { threshold: 5, name: 'Star Player', emoji: '⭐', description: 'Win 5+ MVPs' },
        { threshold: 10, name: 'MVP King', emoji: '👑', description: 'Win 10+ MVPs' },
        { threshold: 20, name: 'Champion', emoji: '🏆', description: 'Win 20+ MVPs' }
    ],
    games: [
        { threshold: 50, name: 'Veteran', emoji: '🎖️', description: 'Play 50+ games' },
        { threshold: 100, name: 'Dedicated', emoji: '💪', description: 'Play 100+ games' },
        { threshold: 200, name: 'Unstoppable', emoji: '⚡', description: 'Play 200+ games' }
    ]
};

// Utility function for creating integer options
function createIntegerOption(option, name, description, required = false) {
    try {
        option.setMinValue(0);
    } catch (err) {
        console.warn(`Could not set min value for ${name} option`);
    }
    return option.setName(name).setDescription(description).setRequired(required);
}

// Define slash commands - Updated to remove CSV commands
const commands = [
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Shows help information for the Stats Bot'),
    
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Shows stats for a user')
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The user to check stats for (defaults to yourself)')
                .setRequired(false)),
    
    new SlashCommandBuilder()
        .setName('team')
        .setDescription('Shows player leaderboard for a team')
        .addStringOption(option => 
            option.setName('team')
                .setDescription('The team to check stats for')
                .setRequired(true)
                .addChoices(
                    { name: 'A-Team', value: 'A-Team' },
                    { name: 'B-Team', value: 'B-Team' }
                )),

    new SlashCommandBuilder()
        .setName('team-stats')
        .setDescription('Shows win/loss record for a team')
        .addStringOption(option => 
            option.setName('team')
                .setDescription('The team to check win/loss record for')
                .setRequired(true)
                .addChoices(
                    { name: 'A-Team', value: 'A-Team' },
                    { name: 'B-Team', value: 'B-Team' }
                )),

    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Shows the overall leaderboard'),
    
    new SlashCommandBuilder()
        .setName('achievements')
        .setDescription('Shows all available achievements and how to unlock them'),
    
    new SlashCommandBuilder()
        .setName('register')
        .setDescription('Register a player')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to register')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('team')
                .setDescription('The team to assign to the user')
                .setRequired(true)
                .addChoices(
                    { name: 'A-Team', value: 'A-Team' },
                    { name: 'B-Team', value: 'B-Team' }
                )),

    new SlashCommandBuilder()
        .setName('addstats')
        .setDescription('Add stats for a player')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to add stats for')
                .setRequired(true))
        .addIntegerOption(option => createIntegerOption(option, 'games', 'Number of games to add', false))
        .addIntegerOption(option => createIntegerOption(option, 'goals', 'Number of goals to add', false))
        .addIntegerOption(option => createIntegerOption(option, 'assists', 'Number of assists to add', false))
        .addIntegerOption(option => createIntegerOption(option, 'saves', 'Number of saves to add', false))
        .addIntegerOption(option => createIntegerOption(option, 'shots', 'Number of shots to add', false))
        .addIntegerOption(option => createIntegerOption(option, 'mvps', 'Number of MVPs to add', false)),
    
    new SlashCommandBuilder()
        .setName('removestats')
        .setDescription('Remove stats for a player')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to remove stats from')
                .setRequired(true))
        .addIntegerOption(option => createIntegerOption(option, 'games', 'Number of games to remove', false))
        .addIntegerOption(option => createIntegerOption(option, 'goals', 'Number of goals to remove', false))
        .addIntegerOption(option => createIntegerOption(option, 'assists', 'Number of assists to remove', false))
        .addIntegerOption(option => createIntegerOption(option, 'saves', 'Number of saves to remove', false))
        .addIntegerOption(option => createIntegerOption(option, 'shots', 'Number of shots to remove', false))
        .addIntegerOption(option => createIntegerOption(option, 'mvps', 'Number of MVPs to remove', false)),
        
    new SlashCommandBuilder()
        .setName('wipe-players')
        .setDescription('DANGER: Wipe all player stats (Admin only)'),

    new SlashCommandBuilder()
        .setName('wipe-teams')
        .setDescription('DANGER: Reset all team records (Admin only)'),

    new SlashCommandBuilder()
        .setName('wipe-all')
        .setDescription('DANGER: Wipe ALL data - complete reset (Admin only)'),

    new SlashCommandBuilder()
        .setName('team-win')
        .setDescription('Add a win to a team')
        .addStringOption(option =>
            option.setName('team')
                .setDescription('The team that won')
                .setRequired(true)
                .addChoices(
                    { name: 'A-Team', value: 'A-Team' },
                    { name: 'B-Team', value: 'B-Team' }
                ))
        .addIntegerOption(option => createIntegerOption(option, 'wins', 'Number of wins to add (default: 1)', false)),

    new SlashCommandBuilder()
        .setName('team-loss')
        .setDescription('Add a loss to a team')
        .addStringOption(option =>
            option.setName('team')
                .setDescription('The team that lost')
                .setRequired(true)
                .addChoices(
                    { name: 'A-Team', value: 'A-Team' },
                    { name: 'B-Team', value: 'B-Team' }
                ))
                .addIntegerOption(option => createIntegerOption(option, 'losses', 'Number of losses to add (default: 1)', false)),

    new SlashCommandBuilder()
        .setName('team-remove-win')
        .setDescription('Remove wins from a team')
        .addStringOption(option =>
            option.setName('team')
                .setDescription('The team to remove wins from')
                .setRequired(true)
                .addChoices(
                    { name: 'A-Team', value: 'A-Team' },
                    { name: 'B-Team', value: 'B-Team' }
                ))
                .addIntegerOption(option => createIntegerOption(option, 'wins', 'Number of wins to remove (default: 1)', false)),

    new SlashCommandBuilder()
        .setName('team-remove-loss')
        .setDescription('Remove losses from a team')
        .addStringOption(option =>
            option.setName('team')
                .setDescription('The team to remove losses from')
                .setRequired(true)
                .addChoices(
                    { name: 'A-Team', value: 'A-Team' },
                    { name: 'B-Team', value: 'B-Team' }
                ))
                .addIntegerOption(option => createIntegerOption(option, 'losses', 'Number of losses to remove (default: 1)', false)),

    new SlashCommandBuilder()
        .setName('compare')
        .setDescription('Compare stats between two players')
        .addUserOption(option =>
            option.setName('player1')
                .setDescription('First player to compare')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('player2')
                .setDescription('Second player to compare')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('recent')
        .setDescription('Show recent game performance for a player')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to check recent form for (defaults to yourself)')
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('games')
                .setDescription('Number of recent games to show (default: 10, max: 20)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(20)),

    new SlashCommandBuilder()
        .setName('my-stats')
        .setDescription('Quick personal stats dashboard'),

    new SlashCommandBuilder()
        .setName('schedule-match')
        .setDescription('Schedule a match between teams (Admin only)')
        .addStringOption(option =>
            option.setName('team1')
                .setDescription('First team (e.g., A-Team, B-Team, or external team like ATG)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('team2')
                .setDescription('Second team (e.g., A-Team, B-Team, or external team)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('datetime')
                .setDescription('Date and time (e.g., "2025-06-30 19:00" or "June 30 7pm")')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('description')
                .setDescription('Optional match description')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('match-calendar')
        .setDescription('View upcoming scheduled matches'),

    new SlashCommandBuilder()
        .setName('cancel-match')
        .setDescription('Cancel a scheduled match (Admin only)')
        .addStringOption(option =>
            option.setName('match-id')
                .setDescription('Specific match ID to cancel (use /cancel-match to see IDs)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('teams')
                .setDescription('Filter by teams (e.g., "A-Team vs B-Team" or just "A-Team")')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('date')
                .setDescription('Filter by match date (e.g., "June 30" or "2025-06-30")')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('create-backup')
        .setDescription('Create a manual backup of all bot data (Admin only)'),

    new SlashCommandBuilder()
        .setName('list-backups')
        .setDescription('List available backups (Admin only)'),

    new SlashCommandBuilder()
        .setName('restore-backup')
        .setDescription('Restore data from a backup (Admin only)')
        .addStringOption(option =>
            option.setName('backup-folder')
                .setDescription('Backup folder name (use /list-backups to see available backups)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('export-data')
        .setDescription('Export all current data as downloadable files (Admin only)'),

    new SlashCommandBuilder()
        .setName('generate-report')
        .setDescription('Generate a comprehensive stats report file')
        .addStringOption(option =>
            option.setName('format')
                .setDescription('Report format')
                .setRequired(false)
                .addChoices(
                    { name: 'Text File (.txt)', value: 'txt' },
                    { name: 'CSV Spreadsheet (.csv)', value: 'csv' },
                    { name: 'HTML Web Page (.html)', value: 'html' }
                ))
        .addStringOption(option =>
            option.setName('team')
                .setDescription('Generate report for specific team only (use /list-teams to see available teams)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('player-report')
        .setDescription('Generate individual player report')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Player to generate report for (defaults to yourself)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('format')
                .setDescription('Report format')
                .setRequired(false)
                .addChoices(
                    { name: 'Text File (.txt)', value: 'txt' },
                    { name: 'HTML Web Page (.html)', value: 'html' }
                )),

    new SlashCommandBuilder()
        .setName('create-team')
        .setDescription('Create a new team (Admin only)')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Name of the new team (e.g., C-Team, Reserves, etc.)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('list-teams')
        .setDescription('List all available teams'),

    new SlashCommandBuilder()
        .setName('delete-team')
        .setDescription('Delete a team (Admin only)')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Name of the team to delete')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('confirmation')
                .setDescription('Type "CONFIRM" to proceed with team deletion')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('rename-team')
        .setDescription('Rename a team (Admin only)')
        .addStringOption(option =>
            option.setName('old-name')
                .setDescription('Current team name')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('new-name')
                .setDescription('New team name')
                .setRequired(true))
];

// Add error handling utility function
async function safeReply(interaction, content, options = {}) {
    try {
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(content);
        } else {
            return await interaction.reply({...content, ...options});
        }
    } catch (error) {
        console.error(`Error replying to interaction: ${error.message}`);
        if (error.code === 10062) { // Unknown Interaction error
            console.log('Interaction expired before response was sent');
        }
    }
}

// Bot ready event
client.once('ready', () => {
    console.log(`Bot is online! Logged in as ${client.user.tag}`);
    
    // Register slash commands
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    (async () => {
        try {
            console.log('Started refreshing application (/) commands.');
            
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commands.map(command => command.toJSON()) },
            );
            
            console.log('Successfully reloaded application (/) commands.');
        } catch (error) {
            console.error('Failed to reload application (/) commands:', error);
        }
    })();

    // Set up HTTP server for ping mechanism
    const server = http.createServer((req, res) => {
        if (req.url === '/ping') {
            res.writeHead(200);
            res.end('pong');
        } else {
            res.writeHead(200);
            res.end('Stats Bot is running!');
        }
    });

    // Start HTTP server
    console.log(`Starting HTTP server on port ${PORT}...`);
    server.listen(PORT, () => {
        console.log(`HTTP server successfully started on port ${PORT}`);
    });

    // Self-pinging to keep bot awake (every 2 minutes)
    setInterval(() => {
        try {
            // Use APP_URL environment variable for production, fallback to localhost for development
            const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
            
            console.log(`[${new Date().toISOString()}] Pinging self at ${appUrl}/ping`);
            
            // Determine which http module to use
            const httpModule = appUrl.startsWith('https') ? require('https') : require('http');
            
            // Send the ping
            const req = httpModule.get(`${appUrl}/ping`, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    console.log(`[${new Date().toISOString()}] Self-ping successful with status: ${res.statusCode}`);
                });
            });
            
            req.on('error', (err) => {
                console.error(`[${new Date().toISOString()}] Self-ping error: ${err.message}`);
            });
            
            req.end();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error during self-ping: ${error.message}`);
        }
    }, 2 * 60 * 1000); // Every 2 minutes

    // Match reminder system (check every hour)
    setInterval(async () => {
        try {
            const upcomingMatches = await db.getUpcomingMatches(20);
            const now = new Date();
            const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
            
            // Check for matches starting within the next hour
            for (const match of upcomingMatches) {
                const matchTime = new Date(match.dateTime);
                
                // If match is within 1 hour and hasn't been notified
                if (matchTime <= oneHourFromNow && matchTime > now && !match.notified) {
                    // Find a general channel to send notification
                    const guild = client.guilds.cache.first();
                    if (guild) {
                        const channel = guild.channels.cache.find(ch => 
                            ch.type === 0 && // Text channel
                            (ch.name.includes('general') || ch.name.includes('announcements') || ch.name.includes('matches'))
                        ) || guild.channels.cache.find(ch => ch.type === 0); // Fallback to first text channel
                        
                        if (channel) {
                            const timeUntilMatch = Math.round((matchTime - now) / (1000 * 60)); // minutes
                            
                            const embed = createEmbed('⏰ Match Reminder', 
                                `🚨 **${match.team1} vs ${match.team2}**\n\n` +
                                `⏰ Starting in **${timeUntilMatch} minutes**!\n` +
                                `📅 ${matchTime.toLocaleDateString()} at ${matchTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n` +
                                (match.description ? `📝 ${match.description}\n` : '') +
                                `\nGood luck to both teams! 🏆`, 
                                config.colors.primary);
                            
                            await channel.send({ embeds: [embed] });
                            
                            // Mark as notified
                            const matches = await db.readScheduledMatchesFile();
                            const matchIndex = matches.findIndex(m => m.id === match.id);
                            if (matchIndex !== -1) {
                                matches[matchIndex].notified = true;
                                await db.writeScheduledMatchesFile(matches);
                            }
                        }
                    }
                }
            }
            
            // Clean up old matches
            await db.cleanupOldMatches();
            
        } catch (error) {
            console.error('Error in match reminder system:', error);
        }
    }, 60 * 60 * 1000); // Every hour

    // Automatic backup system (daily at 3 AM)
    const scheduleBackups = () => {
        const now = new Date();
        const next3AM = new Date();
        next3AM.setHours(3, 0, 0, 0);
        
        // If it's already past 3 AM today, schedule for tomorrow
        if (now >= next3AM) {
            next3AM.setDate(next3AM.getDate() + 1);
        }
        
        const timeUntilBackup = next3AM.getTime() - now.getTime();
        
        setTimeout(async () => {
            try {
                console.log('🔄 Creating automatic daily backup...');
                await db.createBackup('automatic');
                await db.cleanupOldBackups(30); // Keep 30 days of backups
                console.log('✅ Automatic backup completed');
            } catch (error) {
                console.error('❌ Error in automatic backup:', error);
            }
            
            // Schedule next backup in 24 hours
            setInterval(async () => {
                try {
                    console.log('🔄 Creating automatic daily backup...');
                    await db.createBackup('automatic');
                    await db.cleanupOldBackups(30);
                    console.log('✅ Automatic backup completed');
                } catch (error) {
                    console.error('❌ Error in automatic backup:', error);
                }
            }, 24 * 60 * 60 * 1000); // Every 24 hours
            
        }, timeUntilBackup);
        
        console.log(`📅 Next automatic backup scheduled for: ${next3AM.toLocaleString()}`);
    };
    
    // Start backup scheduling
    scheduleBackups();

    // Create initial backup on startup (if no recent backup exists)
    setTimeout(async () => {
        try {
            // Ensure default teams exist
            const allTeams = await db.getAllTeams();
            if (allTeams.length === 0) {
                console.log('🏆 No teams found, creating default teams...');
                const defaultTeamStats = {
                    'A-Team': { wins: 0, losses: 0 },
                    'B-Team': { wins: 0, losses: 0 }
                };
                await db.writeTeamStatsFile(defaultTeamStats);
                console.log('✅ Default teams (A-Team, B-Team) created');
            } else {
                console.log(`✅ Found ${allTeams.length} teams: ${allTeams.join(', ')}`);
            }
            
            const backups = await db.listBackups();
            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            
            const recentBackup = backups.find(backup => 
                new Date(backup.timestamp) > oneDayAgo
            );
            
            if (!recentBackup) {
                console.log('🔄 No recent backup found, creating startup backup...');
                await db.createBackup('startup');
                console.log('✅ Startup backup created');
            } else {
                console.log('✅ Recent backup exists, skipping startup backup');
            }
        } catch (error) {
            console.error('❌ Error during startup initialization:', error);
        }
    }, 30000); // 30 seconds after startup
});

// Check if user has admin role
async function isAdmin(member) {
    if (!member) return false;
    try {
        // If member is not fetched, fetch it first
        if (!member.fetch) {
            console.warn('Member object does not have fetch method');
            return false;
        }
        
        await member.fetch();
        
        // Check if the member has the admin role
        return member.roles.cache.some(role => role.name === config.adminRoleName);
    } catch (error) {
        console.error(`Error checking admin role: ${error.message}`);
        return false;
    }
}

async function getDisplayName(userId, interaction) {
    try {
        // Get the member from the guild
        const member = await interaction.guild.members.fetch(userId);
        // Return the member's display name (nickname if set, otherwise username)
        return member ? member.displayName : 'Unknown User';
    } catch (error) {
        console.error(`Error fetching display name for user ${userId}:`, error);
        // Fallback to username if available, otherwise show 'Unknown User'
        try {
            const user = await interaction.client.users.fetch(userId);
            return user ? user.username : 'Unknown User';
        } catch (err) {
            console.error(`Error fetching user ${userId}:`, err);
            return 'Unknown User';
        }
    }
}

// Create embeds for nice looking messages
function createEmbed(title, description = null, color = config.colors.primary) {
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setTimestamp()
        .setFooter({ text: 'Stats Bot', iconURL: 'https://i.imgur.com/wSTFkRM.png' });
    
    if (description) {
        embed.setDescription(description);
    }
    
    return embed;
}

// Calculate player achievements based on stats
function calculateAchievements(player) {
    const achievements = [];
    
    // Check each achievement category
    Object.keys(ACHIEVEMENTS).forEach(category => {
        const playerStat = category === 'games' ? player.gamesPlayed : player[category];
        
        ACHIEVEMENTS[category].forEach(achievement => {
            if (playerStat >= achievement.threshold) {
                achievements.push(`${achievement.emoji} ${achievement.name}`);
            }
        });
    });
    
    return achievements.length ? achievements.join('\n') : 'No achievements yet';
}

// Calculate achievement progression
function calculateAchievementProgress(player) {
    const progressInfo = [];
    
    Object.keys(ACHIEVEMENTS).forEach(category => {
        const playerStat = category === 'games' ? player.gamesPlayed : player[category];
        
        // Find next achievement in this category
        const nextAchievement = ACHIEVEMENTS[category].find(achievement => 
            playerStat < achievement.threshold
        );
        
        if (nextAchievement) {
            const progress = playerStat;
            const needed = nextAchievement.threshold - playerStat;
            const percentage = Math.round((progress / nextAchievement.threshold) * 100);
            
            progressInfo.push({
                category: category.charAt(0).toUpperCase() + category.slice(1),
                current: progress,
                needed: needed,
                target: nextAchievement.threshold,
                percentage: percentage,
                achievement: nextAchievement,
                emoji: nextAchievement.emoji
            });
        }
    });
    
    return progressInfo;
}

// Parse date string for match scheduling
function parseMatchDateTime(dateTimeStr) {
    try {
        // Try parsing ISO format first (2025-06-30 19:00)
        if (dateTimeStr.match(/^\d{4}-\d{2}-\d{2}\s\d{1,2}:\d{2}$/)) {
            return new Date(dateTimeStr);
        }
        
        // Try parsing natural language (June 30 7pm, Jun 30 19:00)
        const naturalDate = new Date(dateTimeStr);
        if (!isNaN(naturalDate.getTime())) {
            return naturalDate;
        }
        
        throw new Error('Invalid date format');
    } catch (error) {
        throw new Error('Please use format like "2025-06-30 19:00" or "June 30 7pm"');
    }
}

// Create player comparison embed
function createPlayerComparisonEmbed(player1, player2, user1, user2) {
    const embed = new EmbedBuilder()
        .setColor(config.colors.primary)
        .setTitle('⚔️ Player Comparison')
        .setDescription(`**${player1.displayName}** vs **${player2.displayName}**`)
        .setTimestamp();

    // Add comparison fields
    embed.addFields(
        { name: '🏅 Team', value: `${player1.team}\nvs\n${player2.team}`, inline: true },
        { name: '🎮 Games Played', value: `${player1.gamesPlayed}\nvs\n${player2.gamesPlayed}`, inline: true },
        { name: '⚽ Goals', value: `${player1.goals}\nvs\n${player2.goals}`, inline: true },
        { name: '👟 Assists', value: `${player1.assists}\nvs\n${player2.assists}`, inline: true },
        { name: '🧤 Saves', value: `${player1.saves}\nvs\n${player2.saves}`, inline: true },
        { name: '🎯 Shots', value: `${player1.shots || 0}\nvs\n${player2.shots || 0}`, inline: true },
        { name: '🏆 MVPs', value: `${player1.mvps}\nvs\n${player2.mvps}`, inline: true }
    );

    // Calculate and add efficiency stats
    const p1Efficiency = {
        goalsPerGame: player1.gamesPlayed > 0 ? (player1.goals / player1.gamesPlayed).toFixed(2) : '0.00',
        assistsPerGame: player1.gamesPlayed > 0 ? (player1.assists / player1.gamesPlayed).toFixed(2) : '0.00',
        mvpRate: player1.gamesPlayed > 0 ? ((player1.mvps / player1.gamesPlayed) * 100).toFixed(1) : '0.0'
    };

    const p2Efficiency = {
        goalsPerGame: player2.gamesPlayed > 0 ? (player2.goals / player2.gamesPlayed).toFixed(2) : '0.00',
        assistsPerGame: player2.gamesPlayed > 0 ? (player2.assists / player2.gamesPlayed).toFixed(2) : '0.00',
        mvpRate: player2.gamesPlayed > 0 ? ((player2.mvps / player2.gamesPlayed) * 100).toFixed(1) : '0.0'
    };

    embed.addFields(
        { name: '📊 Goals/Game', value: `${p1Efficiency.goalsPerGame}\nvs\n${p2Efficiency.goalsPerGame}`, inline: true },
        { name: '📈 Assists/Game', value: `${p1Efficiency.assistsPerGame}\nvs\n${p2Efficiency.assistsPerGame}`, inline: true },
        { name: '🌟 MVP Rate', value: `${p1Efficiency.mvpRate}%\nvs\n${p2Efficiency.mvpRate}%`, inline: true }
    );

    return embed;
}

// Create recent form embed
function createRecentFormEmbed(player, recentGames, gamesRequested) {
    const teamColor = player.team === 'A-Team' ? config.colors.aTeam : config.colors.bTeam;
    
    const embed = new EmbedBuilder()
        .setColor(teamColor)
        .setTitle(`📈 Recent Form - ${player.displayName}`)
        .setDescription(`Last ${Math.min(recentGames.length, gamesRequested)} games`)
        .setTimestamp();

    if (recentGames.length === 0) {
        embed.addFields({
            name: 'No Recent Games',
            value: 'No game history found. Recent form tracking starts from when games are manually added.',
            inline: false
        });
        return embed;
    }

    // Calculate recent totals
    const recentTotals = recentGames.reduce((totals, game) => {
        totals.goals += game.goals || 0;
        totals.assists += game.assists || 0;
        totals.saves += game.saves || 0;
        totals.shots += game.shots || 0;
        totals.mvps += game.mvps || 0;
        return totals;
    }, { goals: 0, assists: 0, saves: 0, shots: 0, mvps: 0 });

    const avgGoals = (recentTotals.goals / recentGames.length).toFixed(2);
    const avgAssists = (recentTotals.assists / recentGames.length).toFixed(2);
    const avgSaves = (recentTotals.saves / recentGames.length).toFixed(2);

    embed.addFields(
        { name: '⚽ Recent Goals', value: `${recentTotals.goals} total\n${avgGoals} per game`, inline: true },
        { name: '👟 Recent Assists', value: `${recentTotals.assists} total\n${avgAssists} per game`, inline: true },
        { name: '🧤 Recent Saves', value: `${recentTotals.saves} total\n${avgSaves} per game`, inline: true },
        { name: '🎯 Recent Shots', value: `${recentTotals.shots} total`, inline: true },
        { name: '🏆 Recent MVPs', value: `${recentTotals.mvps} awards`, inline: true },
        { name: '📊 Games Analyzed', value: `${recentGames.length} games`, inline: true }
    );

    // Show last few games timeline
    let gamesList = '';
    recentGames.slice(0, 5).forEach((game, index) => {
        const date = new Date(game.timestamp).toLocaleDateString();
        gamesList += `**${date}**: ${game.goals}G ${game.assists}A ${game.saves}S${game.mvps > 0 ? ' 🏆MVP' : ''}\n`;
    });

    if (gamesList) {
        embed.addFields({
            name: '📅 Recent Games',
            value: gamesList,
            inline: false
        });
    }

    return embed;
}

// Create personal dashboard embed
function createPersonalDashboardEmbed(player, recentGames, achievementProgress) {
    const teamColor = player.team === 'A-Team' ? config.colors.aTeam : config.colors.bTeam;
    
    const embed = new EmbedBuilder()
        .setColor(teamColor)
        .setTitle(`🎮 ${player.displayName}'s Dashboard`)
        .setDescription(`Team: **${player.team}**`)
        .setTimestamp();

    // Current stats
    embed.addFields(
        { name: '📊 Current Stats', 
          value: `🎮 **${player.gamesPlayed}** games\n⚽ **${player.goals}** goals\n👟 **${player.assists}** assists\n🧤 **${player.saves}** saves\n🏆 **${player.mvps}** MVPs`, 
          inline: true }
    );

    // Efficiency stats
    const goalsPerGame = player.gamesPlayed > 0 ? (player.goals / player.gamesPlayed).toFixed(2) : '0.00';
    const assistsPerGame = player.gamesPlayed > 0 ? (player.assists / player.gamesPlayed).toFixed(2) : '0.00';
    const mvpRate = player.gamesPlayed > 0 ? ((player.mvps / player.gamesPlayed) * 100).toFixed(1) : '0.0';
    
    embed.addFields(
        { name: '📈 Efficiency', 
          value: `⚽ **${goalsPerGame}** goals/game\n👟 **${assistsPerGame}** assists/game\n🌟 **${mvpRate}%** MVP rate`, 
          inline: true }
    );

    // Recent form summary
    if (recentGames.length > 0) {
        const recentGoals = recentGames.reduce((sum, game) => sum + (game.goals || 0), 0);
        const recentMVPs = recentGames.reduce((sum, game) => sum + (game.mvps || 0), 0);
        
        embed.addFields(
            { name: '📅 Recent Form (Last 5)', 
              value: `⚽ **${recentGoals}** goals\n🏆 **${recentMVPs}** MVPs\n📊 **${recentGames.length}** games`, 
              inline: true }
        );
    }

    // Next achievements
    if (achievementProgress.length > 0) {
        const topProgress = achievementProgress
            .sort((a, b) => b.percentage - a.percentage)
            .slice(0, 3);
        
        let progressText = '';
        topProgress.forEach(progress => {
            progressText += `${progress.emoji} **${progress.achievement.name}**: ${progress.current}/${progress.target} (${progress.percentage}%)\n`;
        });
        
        embed.addFields(
            { name: '🎯 Achievement Progress', 
              value: progressText || 'All achievements unlocked!', 
              inline: false }
        );
    }

    return embed;
}

// Create match calendar embed
function createMatchCalendarEmbed(upcomingMatches) {
    const embed = createEmbed('📅 Match Calendar', 'Upcoming scheduled matches');
    
    if (upcomingMatches.length === 0) {
        embed.setDescription('No upcoming matches scheduled. Use `/schedule-match` to add matches.');
        return embed;
    }
    
    let matchList = '';
    upcomingMatches.forEach((match, index) => {
        const date = new Date(match.dateTime);
        const dateStr = date.toLocaleDateString();
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        matchList += `**${index + 1}.** ${match.team1} vs ${match.team2}\n`;
        matchList += `📅 ${dateStr} at ${timeStr}\n`;
        matchList += `🔢 ID: \`${match.id}\`\n`;
        if (match.description) {
            matchList += `📝 ${match.description}\n`;
        }
        matchList += '\n';
    });
    
    embed.setDescription(matchList);
    embed.addFields({
        name: '🛠️ Management',
        value: 'Use `/cancel-match match-id:<id>` to cancel a specific match.',
        inline: false
    });
    
    return embed;
}

// Create cancel match selection embed
function createCancelMatchEmbed(matchesToCancel) {
    const embed = createEmbed('❌ Cancel Match', 'Select a match to cancel');
    
    if (matchesToCancel.length === 0) {
        embed.setDescription('No matches found matching your criteria.');
        return embed;
    }
    
    let matchList = '';
    matchesToCancel.forEach((match, index) => {
        const date = new Date(match.dateTime);
        const dateStr = date.toLocaleDateString();
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        matchList += `**${index + 1}.** ${match.team1} vs ${match.team2}\n`;
        matchList += `📅 ${dateStr} at ${timeStr}\n`;
        matchList += `🔢 Match ID: \`${match.id}\`\n`;
        if (match.description) {
            matchList += `📝 ${match.description}\n`;
        }
        matchList += '\n';
    });
    
    embed.setDescription(matchList);
    embed.addFields({
        name: '🗑️ How to Cancel',
        value: 'Copy the Match ID of the match you want to cancel and use it with `/cancel-match` again, or contact an admin.',
        inline: false
    });
    
    return embed;
}

// Report Generation Functions
async function generateTextReport(teamFilter = null) {
    const players = await db.getAllPlayers(teamFilter);
    const aTeamStats = await db.getTeamStats('A-Team');
    const bTeamStats = await db.getTeamStats('B-Team');
    const upcomingMatches = await db.getUpcomingMatches(5);
    
    const reportDate = new Date().toLocaleString();
    
    let report = '';
    report += '='.repeat(60) + '\n';
    report += '           DISCORD STATS BOT - TEAM REPORT\n';
    report += '='.repeat(60) + '\n';
    report += `Generated: ${reportDate}\n`;
    report += teamFilter ? `Team Filter: ${teamFilter}\n` : 'Scope: All Teams\n';
    report += '='.repeat(60) + '\n\n';
    
    // Team Records Section
    if (!teamFilter) {
        report += '📊 TEAM STANDINGS\n';
        report += '-'.repeat(30) + '\n';
        
        const aWinRate = aTeamStats.wins + aTeamStats.losses > 0 ? 
            ((aTeamStats.wins / (aTeamStats.wins + aTeamStats.losses)) * 100).toFixed(1) : '0.0';
        const bWinRate = bTeamStats.wins + bTeamStats.losses > 0 ? 
            ((bTeamStats.wins / (bTeamStats.wins + bTeamStats.losses)) * 100).toFixed(1) : '0.0';
        
        report += `A-Team: ${aTeamStats.wins}W-${aTeamStats.losses}L (${aWinRate}% win rate)\n`;
        report += `B-Team: ${bTeamStats.wins}W-${bTeamStats.losses}L (${bWinRate}% win rate)\n\n`;
    }
    
    // Player Statistics
    report += `👥 PLAYER STATISTICS${teamFilter ? ` - ${teamFilter}` : ''}\n`;
    report += '-'.repeat(50) + '\n';
    
    if (players.length === 0) {
        report += 'No players found.\n\n';
    } else {
        // Sort by goals for main table
        players.sort((a, b) => b.goals - a.goals);
        
        report += `${'Name'.padEnd(20)} ${'Team'.padEnd(8)} ${'Games'.padEnd(6)} ${'Goals'.padEnd(6)} ${'Assists'.padEnd(7)} ${'Saves'.padEnd(6)} ${'Shots'.padEnd(6)} ${'MVPs'.padEnd(5)}\n`;
        report += '-'.repeat(85) + '\n';
        
        players.forEach(player => {
            report += `${player.displayName.substring(0, 19).padEnd(20)} `;
            report += `${player.team.padEnd(8)} `;
            report += `${player.gamesPlayed.toString().padEnd(6)} `;
            report += `${player.goals.toString().padEnd(6)} `;
            report += `${player.assists.toString().padEnd(7)} `;
            report += `${player.saves.toString().padEnd(6)} `;
            report += `${(player.shots || 0).toString().padEnd(6)} `;
            report += `${player.mvps.toString().padEnd(5)}\n`;
        });
        report += '\n';
        
        // Top Performers
        report += '🏆 TOP PERFORMERS\n';
        report += '-'.repeat(20) + '\n';
        
        const topScorer = players[0];
        const topAssists = [...players].sort((a, b) => b.assists - a.assists)[0];
        const topSaves = [...players].sort((a, b) => b.saves - a.saves)[0];
        const topMVP = [...players].sort((a, b) => b.mvps - a.mvps)[0];
        
        report += `Top Scorer: ${topScorer.displayName} (${topScorer.goals} goals)\n`;
        report += `Most Assists: ${topAssists.displayName} (${topAssists.assists} assists)\n`;
        report += `Most Saves: ${topSaves.displayName} (${topSaves.saves} saves)\n`;
        report += `Most MVPs: ${topMVP.displayName} (${topMVP.mvps} MVPs)\n\n`;
    }
    
    // Upcoming Matches
    if (upcomingMatches.length > 0) {
        report += '📅 UPCOMING MATCHES\n';
        report += '-'.repeat(25) + '\n';
        
        upcomingMatches.forEach((match, index) => {
            const date = new Date(match.dateTime);
            report += `${index + 1}. ${match.team1} vs ${match.team2}\n`;
            report += `   Date: ${date.toLocaleDateString()} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n`;
            if (match.description) {
                report += `   Note: ${match.description}\n`;
            }
            report += '\n';
        });
    }
    
    report += '='.repeat(60) + '\n';
    report += 'End of Report - Generated by Discord Stats Bot\n';
    report += '='.repeat(60) + '\n';
    
    return report;
}

async function generateCSVReport(teamFilter = null) {
    const players = await db.getAllPlayers(teamFilter);
    
    let csv = 'Player Name,Team,Games Played,Goals,Assists,Saves,Shots,MVPs,Goals per Game,Assists per Game,MVP Rate %\n';
    
    players.forEach(player => {
        const goalsPerGame = player.gamesPlayed > 0 ? (player.goals / player.gamesPlayed).toFixed(2) : '0.00';
        const assistsPerGame = player.gamesPlayed > 0 ? (player.assists / player.gamesPlayed).toFixed(2) : '0.00';
        const mvpRate = player.gamesPlayed > 0 ? ((player.mvps / player.gamesPlayed) * 100).toFixed(1) : '0.0';
        
        csv += `"${player.displayName}","${player.team}",${player.gamesPlayed},${player.goals},${player.assists},${player.saves},${player.shots || 0},${player.mvps},${goalsPerGame},${assistsPerGame},${mvpRate}\n`;
    });
    
    return csv;
}

async function generateHTMLReport(teamFilter = null) {
    const players = await db.getAllPlayers(teamFilter);
    const aTeamStats = await db.getTeamStats('A-Team');
    const bTeamStats = await db.getTeamStats('B-Team');
    const upcomingMatches = await db.getUpcomingMatches(5);
    
    const reportDate = new Date().toLocaleString();
    
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Discord Stats Bot Report</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(45deg, #ff5555, #5555ff);
            color: white;
            padding: 30px;
            text-align: center;
        }
        .content {
            padding: 30px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        th {
            background: #f8f9fa;
            font-weight: bold;
            color: #495057;
        }
        .team-a { color: #ff5555; font-weight: bold; }
        .team-b { color: #5555ff; font-weight: bold; }
        .section {
            margin: 30px 0;
        }
        .section h2 {
            color: #495057;
            border-bottom: 2px solid #007bff;
            padding-bottom: 10px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .stat-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .match-item {
            background: #f8f9fa;
            padding: 15px;
            margin: 10px 0;
            border-radius: 8px;
            border-left: 4px solid #007bff;
        }
        .footer {
            text-align: center;
            padding: 20px;
            background: #f8f9fa;
            color: #6c757d;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🏆 Discord Stats Bot Report</h1>
            <p>Generated: ${reportDate}</p>
            ${teamFilter ? `<p>Team Filter: ${teamFilter}</p>` : '<p>All Teams Report</p>'}
        </div>
        
        <div class="content">`;
    
    // Team Standings
    if (!teamFilter) {
        const aWinRate = aTeamStats.wins + aTeamStats.losses > 0 ? 
            ((aTeamStats.wins / (aTeamStats.wins + aTeamStats.losses)) * 100).toFixed(1) : '0.0';
        const bWinRate = bTeamStats.wins + bTeamStats.losses > 0 ? 
            ((bTeamStats.wins / (bTeamStats.wins + bTeamStats.losses)) * 100).toFixed(1) : '0.0';
        
        html += `
            <div class="section">
                <h2>📊 Team Standings</h2>
                <div class="stats-grid">
                    <div class="stat-card">
                        <h3 class="team-a">A-Team</h3>
                        <p><strong>${aTeamStats.wins}</strong> Wins</p>
                        <p><strong>${aTeamStats.losses}</strong> Losses</p>
                        <p><strong>${aWinRate}%</strong> Win Rate</p>
                    </div>
                    <div class="stat-card">
                        <h3 class="team-b">B-Team</h3>
                        <p><strong>${bTeamStats.wins}</strong> Wins</p>
                        <p><strong>${bTeamStats.losses}</strong> Losses</p>
                        <p><strong>${bWinRate}%</strong> Win Rate</p>
                    </div>
                </div>
            </div>`;
    }
    
    // Player Statistics
    html += `
        <div class="section">
            <h2>👥 Player Statistics</h2>`;
    
    if (players.length === 0) {
        html += '<p>No players found.</p>';
    } else {
        players.sort((a, b) => b.goals - a.goals);
        
        html += `
            <table>
                <thead>
                    <tr>
                        <th>Player</th>
                        <th>Team</th>
                        <th>Games</th>
                        <th>Goals</th>
                        <th>Assists</th>
                        <th>Saves</th>
                        <th>Shots</th>
                        <th>MVPs</th>
                        <th>Goals/Game</th>
                        <th>MVP Rate</th>
                    </tr>
                </thead>
                <tbody>`;
        
        players.forEach(player => {
            const teamClass = player.team === 'A-Team' ? 'team-a' : 'team-b';
            const goalsPerGame = player.gamesPlayed > 0 ? (player.goals / player.gamesPlayed).toFixed(2) : '0.00';
            const mvpRate = player.gamesPlayed > 0 ? ((player.mvps / player.gamesPlayed) * 100).toFixed(1) : '0.0';
            
            html += `
                <tr>
                    <td><strong>${player.displayName}</strong></td>
                    <td class="${teamClass}">${player.team}</td>
                    <td>${player.gamesPlayed}</td>
                    <td>${player.goals}</td>
                    <td>${player.assists}</td>
                    <td>${player.saves}</td>
                    <td>${player.shots || 0}</td>
                    <td>${player.mvps}</td>
                    <td>${goalsPerGame}</td>
                    <td>${mvpRate}%</td>
                </tr>`;
        });
        
        html += `
                </tbody>
            </table>`;
    }
    
    html += '</div>';
    
    // Upcoming Matches
    if (upcomingMatches.length > 0) {
        html += `
            <div class="section">
                <h2>📅 Upcoming Matches</h2>`;
        
        upcomingMatches.forEach((match, index) => {
            const date = new Date(match.dateTime);
            html += `
                <div class="match-item">
                    <h4>${match.team1} vs ${match.team2}</h4>
                    <p><strong>Date:</strong> ${date.toLocaleDateString()} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                    ${match.description ? `<p><strong>Description:</strong> ${match.description}</p>` : ''}
                </div>`;
        });
        
        html += '</div>';
    }
    
    html += `
        </div>
        
        <div class="footer">
            <p>Generated by Discord Stats Bot | ${reportDate}</p>
        </div>
    </div>
</body>
</html>`;
    
    return html;
}

async function generatePlayerReport(player, format = 'txt') {
    const recentGames = await db.getRecentGames(player.discordId, 10);
    const achievements = calculateAchievements(player);
    const progress = calculateAchievementProgress(player);
    
    if (format === 'html') {
        return generatePlayerHTMLReport(player, recentGames, achievements, progress);
    } else {
        return generatePlayerTextReport(player, recentGames, achievements, progress);
    }
}

function generatePlayerTextReport(player, recentGames, achievements, progress) {
    const reportDate = new Date().toLocaleString();
    const goalsPerGame = player.gamesPlayed > 0 ? (player.goals / player.gamesPlayed).toFixed(2) : '0.00';
    const assistsPerGame = player.gamesPlayed > 0 ? (player.assists / player.gamesPlayed).toFixed(2) : '0.00';
    const mvpRate = player.gamesPlayed > 0 ? ((player.mvps / player.gamesPlayed) * 100).toFixed(1) : '0.0';
    
    let report = '';
    report += '='.repeat(50) + '\n';
    report += `PLAYER REPORT: ${player.displayName}\n`;
    report += '='.repeat(50) + '\n';
    report += `Generated: ${reportDate}\n`;
    report += `Team: ${player.team}\n`;
    report += '='.repeat(50) + '\n\n';
    
    // Basic Stats
    report += '📊 STATISTICS\n';
    report += '-'.repeat(15) + '\n';
    report += `Games Played: ${player.gamesPlayed}\n`;
    report += `Goals: ${player.goals} (${goalsPerGame} per game)\n`;
    report += `Assists: ${player.assists} (${assistsPerGame} per game)\n`;
    report += `Saves: ${player.saves}\n`;
    report += `Shots: ${player.shots || 0}\n`;
    report += `MVPs: ${player.mvps} (${mvpRate}% of games)\n\n`;
    
    // Recent Form
    if (recentGames.length > 0) {
        report += `📈 RECENT FORM (Last ${recentGames.length} games)\n`;
        report += '-'.repeat(30) + '\n';
        
        const recentTotals = recentGames.reduce((totals, game) => {
            totals.goals += game.goals || 0;
            totals.assists += game.assists || 0;
            totals.saves += game.saves || 0;
            totals.mvps += game.mvps || 0;
            return totals;
        }, { goals: 0, assists: 0, saves: 0, mvps: 0 });
        
        report += `Goals: ${recentTotals.goals} (${(recentTotals.goals / recentGames.length).toFixed(2)} avg)\n`;
        report += `Assists: ${recentTotals.assists} (${(recentTotals.assists / recentGames.length).toFixed(2)} avg)\n`;
        report += `Saves: ${recentTotals.saves} (${(recentTotals.saves / recentGames.length).toFixed(2)} avg)\n`;
        report += `MVPs: ${recentTotals.mvps}\n\n`;
        
        report += 'Recent Games:\n';
        recentGames.slice(0, 5).forEach((game, index) => {
            const date = new Date(game.timestamp).toLocaleDateString();
            report += `${index + 1}. ${date}: ${game.goals}G ${game.assists}A ${game.saves}S${game.mvps > 0 ? ' MVP' : ''}\n`;
        });
        report += '\n';
    }
    
    // Achievements
    report += '🏆 ACHIEVEMENTS\n';
    report += '-'.repeat(15) + '\n';
    if (achievements === 'No achievements yet') {
        report += 'No achievements unlocked yet.\n\n';
    } else {
        const achievementList = achievements.split('\n');
        achievementList.forEach(achievement => {
            report += `${achievement}\n`;
        });
        report += '\n';
    }
    
    // Progress
    if (progress.length > 0) {
        report += '🎯 ACHIEVEMENT PROGRESS\n';
        report += '-'.repeat(25) + '\n';
        progress.slice(0, 5).forEach(prog => {
            report += `${prog.achievement.name}: ${prog.current}/${prog.target} (${prog.percentage}%)\n`;
            report += `  Need ${prog.needed} more ${prog.category.toLowerCase()}\n`;
        });
        report += '\n';
    }
    
    report += '='.repeat(50) + '\n';
    report += 'End of Player Report\n';
    report += '='.repeat(50) + '\n';
    
    return report;
}

function generatePlayerHTMLReport(player, recentGames, achievements, progress) {
    const reportDate = new Date().toLocaleString();
    const teamColor = player.team === 'A-Team' ? '#ff5555' : '#5555ff';
    const goalsPerGame = player.gamesPlayed > 0 ? (player.goals / player.gamesPlayed).toFixed(2) : '0.00';
    const assistsPerGame = player.gamesPlayed > 0 ? (player.assists / player.gamesPlayed).toFixed(2) : '0.00';
    const mvpRate = player.gamesPlayed > 0 ? ((player.mvps / player.gamesPlayed) * 100).toFixed(1) : '0.0';
    
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${player.displayName} - Player Report</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: ${teamColor};
            color: white;
            padding: 30px;
            text-align: center;
        }
        .content {
            padding: 30px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .stat-card {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .stat-value {
            font-size: 24px;
            font-weight: bold;
            color: ${teamColor};
        }
        .section {
            margin: 25px 0;
        }
        .section h3 {
            color: #495057;
            border-bottom: 2px solid ${teamColor};
            padding-bottom: 8px;
        }
        .progress-bar {
            background: #e9ecef;
            border-radius: 10px;
            overflow: hidden;
            margin: 5px 0;
        }
        .progress-fill {
            background: ${teamColor};
            height: 20px;
            border-radius: 10px;
            transition: width 0.3s ease;
        }
        .game-item {
            background: #f8f9fa;
            padding: 10px;
            margin: 5px 0;
            border-radius: 5px;
            border-left: 3px solid ${teamColor};
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🏆 ${player.displayName}</h1>
            <h2>${player.team}</h2>
            <p>Player Report - ${reportDate}</p>
        </div>
        
        <div class="content">
            <div class="section">
                <h3>📊 Statistics</h3>
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">${player.gamesPlayed}</div>
                        <div>Games Played</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${player.goals}</div>
                        <div>Goals (${goalsPerGame}/game)</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${player.assists}</div>
                        <div>Assists (${assistsPerGame}/game)</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${player.saves}</div>
                        <div>Saves</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${player.shots || 0}</div>
                        <div>Shots</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${player.mvps}</div>
                        <div>MVPs (${mvpRate}%)</div>
                    </div>
                </div>
            </div>`;
    
    // Recent Games
    if (recentGames.length > 0) {
        html += `
            <div class="section">
                <h3>📈 Recent Form (Last ${recentGames.length} games)</h3>`;
        
        recentGames.slice(0, 5).forEach((game, index) => {
            const date = new Date(game.timestamp).toLocaleDateString();
            html += `
                <div class="game-item">
                    <strong>${date}:</strong> ${game.goals} Goals, ${game.assists} Assists, ${game.saves} Saves${game.mvps > 0 ? ' 🏆 MVP' : ''}
                </div>`;
        });
        
        html += '</div>';
    }
    
    // Achievement Progress
    if (progress.length > 0) {
        html += `
            <div class="section">
                <h3>🎯 Achievement Progress</h3>`;
        
        progress.slice(0, 5).forEach(prog => {
            html += `
                <div style="margin: 15px 0;">
                    <div><strong>${prog.achievement.name}</strong> - ${prog.current}/${prog.target} (${prog.percentage}%)</div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${prog.percentage}%"></div>
                    </div>
                    <small>Need ${prog.needed} more ${prog.category.toLowerCase()}</small>
                </div>`;
        });
        
        html += '</div>';
    }
    
    html += `
        </div>
    </div>
</body>
</html>`;
    
    return html;
}

// Create achievements list embed
function createAchievementsEmbed() {
    const embed = createEmbed('🏆 Available Achievements', 'Complete these challenges to unlock achievements!');
    
    Object.keys(ACHIEVEMENTS).forEach(category => {
        const categoryName = category.charAt(0).toUpperCase() + category.slice(1);
        let achievementsList = '';
        
        ACHIEVEMENTS[category].forEach(achievement => {
            achievementsList += `${achievement.emoji} **${achievement.name}**: ${achievement.description}\n`;
        });
        
        embed.addFields({
            name: `${categoryName} Achievements`,
            value: achievementsList,
            inline: false
        });
    });
    
    embed.addFields({
        name: '📈 **Track Your Progress**',
        value: 'Use `/my-stats` to see your progress toward next achievements!\nAchievement notifications coming soon! 🎉',
        inline: false
    });
    
    return embed;
}

// Create player stats embed (updated to remove demos)
function playerStatsEmbed(player) {
    const teamColor = player.team === 'A-Team' ? config.colors.aTeam : config.colors.bTeam;
    
    return new EmbedBuilder()
        .setColor(teamColor)
        .setTitle(`${player.displayName}'s Stats`)
        .setDescription(`Team: **${player.team}**`)
        .addFields(
            { name: '🎮 Games Played', value: player.gamesPlayed.toString(), inline: true },
            { name: '⚽ Goals', value: player.goals.toString(), inline: true },
            { name: '👟 Assists', value: player.assists.toString(), inline: true },
            { name: '🧤 Saves', value: player.saves.toString(), inline: true },
            { name: '🎯 Shots', value: (player.shots || 0).toString(), inline: true },
            { name: '🏆 MVPs', value: player.mvps.toString(), inline: true },
            { name: '👑 Achievements', value: calculateAchievements(player) }
        )
        .setFooter({ text: 'Stats Bot', iconURL: 'https://i.imgur.com/wSTFkRM.png' })
        .setTimestamp();
}

// Interaction handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    try {
        const commandName = interaction.commandName;
        
        // Help command (updated to include new commands)
        if (commandName === 'help') {
            const embed = createEmbed('Stats Bot Help', 'List of available commands:');
            
            embed.addFields(
                // Basic Commands
                { 
                    name: '📊 **Basic Commands**', 
                    value: '`/help` - Shows this help message\n' +
                           '`/stats [user]` - Shows stats for a user\n' +
                           '`/my-stats` - Quick personal dashboard\n' +
                           '`/leaderboard` - Shows overall leaderboard\n' +
                           '`/achievements` - Shows available achievements', 
                    inline: false 
                },
                
                // Analysis Commands
                { 
                    name: '📈 **Analysis & Comparison**', 
                    value: '`/compare <player1> <player2>` - Compare two players side-by-side\n' +
                           '`/recent [user] [games]` - Show recent game performance\n' +
                           '`/team <team>` - Shows player leaderboard for a team\n' +
                           '`/team-stats <team>` - Shows win/loss record for a team', 
                    inline: false 
                },
                
                // Match Management
                { 
                    name: '🗓️ **Match Management**', 
                    value: '`/schedule-match <team1> <team2> <datetime>` - Schedule match (Admin)\n' +
                           '`/cancel-match [match-id] [teams] [date]` - Cancel scheduled match (Admin)\n' +
                           '`/match-calendar` - View upcoming scheduled matches\n' +
                           '💡 **Teams**: Use A-Team, B-Team, or any custom team name (ATG, etc.)', 
                    inline: false 
                },
                
                // Backup & Data Management
                { 
                    name: '💾 **Backup & Data Management**', 
                    value: '`/create-backup` - Create manual backup (Admin)\n' +
                           '`/list-backups` - List available backups (Admin)\n' +
                           '`/restore-backup <folder>` - Restore from backup (Admin)\n' +
                           '`/export-data` - Export data as JSON file (Admin)', 
                    inline: false 
                },
                
                // Report Generation
                { 
                    name: '📄 **Report Generation**', 
                    value: '`/generate-report [format] [team]` - Generate downloadable stats report\n' +
                           '`/player-report [user] [format]` - Generate individual player report\n' +
                           '💡 **Formats**: Text (.txt), CSV (.csv), HTML (.html)', 
                    inline: false 
                },
                
                // Admin Commands Header
                { 
                    name: '⚙️ **Admin Commands**', 
                    value: 'The following commands require the Scrimster role:', 
                    inline: false 
                },
                
                // Player Management
                { 
                    name: '👥 **Player Management**', 
                    value: '`/register <user> <team>` - Register a new player to a team', 
                    inline: true 
                },
                
                // Stats Management
                { 
                    name: '📈 **Stats Management**', 
                    value: '`/addstats <user> [stats...]` - Add stats for a player\n' +
                           '`/removestats <user> [stats...]` - Remove stats from a player', 
                    inline: true 
                },
                
                // Team Record Management
                { 
                    name: '🏅 **Team Records**', 
                    value: '`/team-win <team> [wins]` - Add win(s) to team\n' +
                           '`/team-loss <team> [losses]` - Add loss(es) to team\n' +
                           '`/team-remove-win <team> [wins]` - Remove win(s)\n' +
                           '`/team-remove-loss <team> [losses]` - Remove loss(es)\n\n' +
                           '💡 **Note**: All commands work with any team name!', 
                    inline: false 
                },
                
                // Dangerous Commands
                { 
                    name: '⚠️ **DANGER ZONE - Data Reset Commands**', 
                    value: '**Use with extreme caution! Requires confirmation.**\n' +
                           '`/wipe-players` - 🔥 Wipe all player stats (type "CONFIRM")\n' +
                           '`/wipe-teams` - 🔥 Reset all team records (type "CONFIRM")\n' +
                           '`/wipe-all` - 💀 **COMPLETE RESET** (type "CONFIRM DELETE ALL")\n\n' +
                           '💾 **Safety**: All wipe commands create automatic backups first!', 
                    inline: false 
                }
            );
            
            await interaction.reply({ embeds: [embed] });
            return;
        }
        
        // Create Backup command (Admin only)
        if (commandName === 'create-backup') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                await interaction.deferReply();
                
                const backup = await db.createBackup('manual');
                
                const embed = createEmbed('✅ Backup Created', 
                    `📦 **Manual backup completed successfully!**\n\n` +
                    `📅 **Created**: ${new Date(backup.manifest.timestamp).toLocaleString()}\n` +
                    `📁 **Folder**: \`${path.basename(backup.folder)}\`\n` +
                    `📊 **Files Backed Up**: ${backup.manifest.filesBackedUp}\n\n` +
                    `💡 **Tip**: Use \`/list-backups\` to see all available backups.\n` +
                    `🔄 **Restore**: Use \`/restore-backup\` if you ever need to restore this data.`, 
                    config.colors.success);
                
                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Error creating backup:', error);
                await interaction.editReply({
                    content: `❌ Error creating backup: ${error.message}`
                });
            }
            
            return;
        }
        
        // Create Team command (Admin only)
        if (commandName === 'create-team') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const teamName = interaction.options.getString('name').trim();
            
            // Validate team name
            if (teamName.length < 2 || teamName.length > 50) {
                await interaction.reply({
                    content: 'Team name must be between 2 and 50 characters long.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                await db.createTeam(teamName);
                
                const embed = createEmbed('✅ Team Created', 
                    `🏆 **${teamName}** has been created successfully!\n\n` +
                    `📊 **Initial Record**: 0 wins, 0 losses\n` +
                    `👥 **Players**: Ready to register players with \`/register\`\n` +
                    `📋 **View Teams**: Use \`/list-teams\` to see all teams`, 
                    config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                await interaction.reply({
                    content: `❌ Error creating team: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // List Teams command
        if (commandName === 'list-teams') {
            try {
                const allTeams = await db.getAllTeams();
                const teamStats = await db.readTeamStatsFile();
                
                const embed = createEmbed('🏆 Available Teams', 
                    allTeams.length > 0 ? 'Here are all available teams:' : 'No teams found.');
                
                if (allTeams.length === 0) {
                    embed.addFields({
                        name: '💡 Create Your First Team',
                        value: 'Use `/create-team` to create a new team.',
                        inline: false
                    });
                } else {
                    let teamList = '';
                    allTeams.forEach((team, index) => {
                        const stats = teamStats[team];
                        const winRate = stats.wins + stats.losses > 0 ? 
                            ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1) : '0.0';
                        
                        teamList += `**${index + 1}. ${team}**\n`;
                        teamList += `📊 Record: ${stats.wins}W-${stats.losses}L (${winRate}% win rate)\n\n`;
                    });
                    
                    embed.setDescription(teamList);
                    
                    embed.addFields({
                        name: '🛠️ Team Management',
                        value: '• `/create-team` - Create new team\n' +
                               '• `/rename-team` - Rename existing team\n' +
                               '• `/delete-team` - Delete empty team',
                        inline: false
                    });
                }
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error listing teams:', error);
                await interaction.reply({
                    content: `❌ Error listing teams: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // Delete Team command (Admin only)
        if (commandName === 'delete-team') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const teamName = interaction.options.getString('name').trim();
            const confirmation = interaction.options.getString('confirmation');
            
            // Check confirmation
            if (confirmation !== 'CONFIRM') {
                await interaction.reply({
                    content: '❌ **Confirmation failed!**\n\nTo delete a team, you must type exactly: `CONFIRM`\n\n⚠️ **Note**: You can only delete teams that have no players assigned.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                await db.deleteTeam(teamName);
                
                const embed = createEmbed('✅ Team Deleted', 
                    `🗑️ **${teamName}** has been permanently deleted.\n\n` +
                    `📊 **What was removed:**\n` +
                    `• Team record (wins/losses)\n` +
                    `• Team from available options\n\n` +
                    `💡 **Note**: No player data was affected.`, 
                    config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                await interaction.reply({
                    content: `❌ Error deleting team: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // Rename Team command (Admin only)
        if (commandName === 'rename-team') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const oldName = interaction.options.getString('old-name').trim();
            const newName = interaction.options.getString('new-name').trim();
            
            // Validate new team name
            if (newName.length < 2 || newName.length > 50) {
                await interaction.reply({
                    content: 'New team name must be between 2 and 50 characters long.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                const result = await db.renameTeam(oldName, newName);
                
                const embed = createEmbed('✅ Team Renamed', 
                    `🔄 **${result.oldName}** has been renamed to **${result.newName}**!\n\n` +
                    `📊 **What was updated:**\n` +
                    `• Team record maintained\n` +
                    `• ${result.playersUpdated} player(s) updated\n` +
                    `• All references changed\n\n` +
                    `💡 **All historical data preserved.**`, 
                    config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                await interaction.reply({
                    content: `❌ Error renaming team: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // Generate Report command
        if (commandName === 'generate-report') {
            try {
                await interaction.deferReply();
                
                const format = interaction.options.getString('format') || 'txt';
                const teamFilter = interaction.options.getString('team');
                
                // Validate team if specified
                if (teamFilter) {
                    const allTeams = await db.getAllTeams();
                    if (!allTeams.includes(teamFilter)) {
                        await interaction.editReply({
                            content: `Team "${teamFilter}" does not exist. Use \`/list-teams\` to see available teams.`
                        });
                        return;
                    }
                }
                
                let fileContent, fileName, fileExtension;
                
                switch (format) {
                    case 'csv':
                        fileContent = await generateCSVReport(teamFilter);
                        fileExtension = 'csv';
                        break;
                    case 'html':
                        fileContent = await generateHTMLReport(teamFilter);
                        fileExtension = 'html';
                        break;
                    default:
                        fileContent = await generateTextReport(teamFilter);
                        fileExtension = 'txt';
                }
                
                // Create filename
                const dateStr = new Date().toISOString().slice(0, 10);
                const teamStr = teamFilter ? `-${teamFilter.replace('-', '')}` : '';
                fileName = `stats-report${teamStr}-${dateStr}.${fileExtension}`;
                
                // Create attachment
                const buffer = Buffer.from(fileContent, 'utf8');
                const attachment = new AttachmentBuilder(buffer, { name: fileName });
                
                const embed = createEmbed('📊 Stats Report Generated', 
                    `✅ **${format.toUpperCase()} report created successfully!**\n\n` +
                    `📁 **File**: ${fileName}\n` +
                    `📋 **Format**: ${format.toUpperCase()}\n` +
                    (teamFilter ? `🏆 **Team**: ${teamFilter}\n` : '📊 **Scope**: All Teams\n') +
                    `📅 **Generated**: ${new Date().toLocaleString()}\n\n` +
                    `💾 **Download the attached file to save your stats report.**`, 
                    config.colors.success);
                
                await interaction.editReply({ 
                    embeds: [embed],
                    files: [attachment]
                });
            } catch (error) {
                console.error('Error generating report:', error);
                await interaction.editReply({
                    content: `❌ Error generating report: ${error.message}`
                });
            }
            
            return;
        }
        
        // Player Report command
        if (commandName === 'player-report') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const format = interaction.options.getString('format') || 'txt';
            
            try {
                await interaction.deferReply();
                
                // Get player from database
                const player = await db.getPlayer(targetUser.id);
                
                if (!player) {
                    await interaction.editReply({
                        content: `${targetUser.username} is not registered yet. An admin can register them with the \`/register\` command.`
                    });
                    return;
                }
                
                // Generate player report
                const reportContent = await generatePlayerReport(player, format);
                
                // Create filename
                const dateStr = new Date().toISOString().slice(0, 10);
                const playerName = player.displayName.replace(/[^a-zA-Z0-9]/g, '');
                const fileName = `player-report-${playerName}-${dateStr}.${format}`;
                
                // Create attachment
                const buffer = Buffer.from(reportContent, 'utf8');
                const attachment = new AttachmentBuilder(buffer, { name: fileName });
                
                const embed = createEmbed('👤 Player Report Generated', 
                    `✅ **Individual report created for ${player.displayName}!**\n\n` +
                    `📁 **File**: ${fileName}\n` +
                    `📋 **Format**: ${format.toUpperCase()}\n` +
                    `🏆 **Team**: ${player.team}\n` +
                    `📅 **Generated**: ${new Date().toLocaleString()}\n\n` +
                    `💾 **Download the attached file for a detailed player analysis.**`, 
                    config.colors.success);
                
                await interaction.editReply({ 
                    embeds: [embed],
                    files: [attachment]
                });
            } catch (error) {
                console.error('Error generating player report:', error);
                await interaction.editReply({
                    content: `❌ Error generating player report: ${error.message}`
                });
            }
            
            return;
        }
        
        // List Backups command (Admin only)
        if (commandName === 'list-backups') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                const backups = await db.listBackups();
                
                const embed = createEmbed('📦 Available Backups', 
                    backups.length > 0 ? 'Here are all available backups:' : 'No backups found.');
                
                if (backups.length === 0) {
                    embed.addFields({
                        name: '💡 Create Your First Backup',
                        value: 'Use `/create-backup` to create a manual backup of your data.',
                        inline: false
                    });
                } else {
                    // Show most recent 10 backups
                    let backupList = '';
                    backups.slice(0, 10).forEach((backup, index) => {
                        const date = new Date(backup.timestamp);
                        const dateStr = date.toLocaleDateString();
                        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        
                        backupList += `**${index + 1}.** \`${backup.folder}\`\n`;
                        backupList += `📅 ${dateStr} at ${timeStr} (${backup.type})\n`;
                        backupList += `📊 ${backup.filesBackedUp} files\n\n`;
                    });
                    
                    embed.setDescription(backupList);
                    
                    if (backups.length > 10) {
                        embed.addFields({
                            name: `📋 Showing 10 of ${backups.length} backups`,
                            value: 'Only the most recent backups are shown.',
                            inline: false
                        });
                    }
                    
                    embed.addFields({
                        name: '🔄 How to Restore',
                        value: 'Copy the backup folder name and use `/restore-backup backup-folder:<name>`',
                        inline: false
                    });
                }
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error listing backups:', error);
                await interaction.reply({
                    content: `❌ Error listing backups: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // Restore Backup command (Admin only)
        if (commandName === 'restore-backup') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const backupFolder = interaction.options.getString('backup-folder');
            
            try {
                await interaction.deferReply();
                
                // Create a backup before restoring (safety measure)
                await db.createBackup('pre-restore');
                
                const filesRestored = await db.restoreFromBackup(backupFolder);
                
                const embed = createEmbed('🔄 Data Restored', 
                    `✅ **Successfully restored data from backup!**\n\n` +
                    `📁 **Backup Used**: \`${backupFolder}\`\n` +
                    `📊 **Files Restored**: ${filesRestored}\n` +
                    `💾 **Safety Backup**: Created automatic backup before restore\n\n` +
                    `⚠️ **Important**: The bot will reload with the restored data.`, 
                    config.colors.success);
                
                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Error restoring backup:', error);
                await interaction.editReply({
                    content: `❌ Error restoring backup: ${error.message}\n\nPlease check that the backup folder name is correct using \`/list-backups\`.`
                });
            }
            
            return;
        }
        
        // Export Data command (Admin only)
        if (commandName === 'export-data') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                await interaction.deferReply();
                
                // Read all data files
                const players = await db.readPlayersFile();
                const teamStats = await db.readTeamStatsFile();
                const gameHistory = await db.readGameHistoryFile();
                const scheduledMatches = await db.readScheduledMatchesFile();
                
                // Create export package
                const exportData = {
                    exportDate: new Date().toISOString(),
                    version: '1.0',
                    data: {
                        players,
                        teamStats,
                        gameHistory,
                        scheduledMatches
                    },
                    summary: {
                        totalPlayers: players.length,
                        totalGames: gameHistory.length,
                        scheduledMatches: scheduledMatches.length
                    }
                };
                
                // Create downloadable file
                const exportJson = JSON.stringify(exportData, null, 2);
                const buffer = Buffer.from(exportJson, 'utf8');
                const filename = `stats-export-${new Date().toISOString().slice(0, 10)}.json`;
                
                const attachment = new AttachmentBuilder(buffer, { name: filename });
                
                const embed = createEmbed('📤 Data Export Ready', 
                    `✅ **Export completed successfully!**\n\n` +
                    `📊 **Export Summary**:\n` +
                    `👥 ${exportData.summary.totalPlayers} players\n` +
                    `🎮 ${exportData.summary.totalGames} game records\n` +
                    `📅 ${exportData.summary.scheduledMatches} scheduled matches\n\n` +
                    `💾 **Download the attached JSON file to save your data externally.**\n` +
                    `🔄 This file can be used to restore data if needed.`, 
                    config.colors.success);
                
                await interaction.editReply({ 
                    embeds: [embed],
                    files: [attachment]
                });
            } catch (error) {
                console.error('Error exporting data:', error);
                await interaction.editReply({
                    content: `❌ Error exporting data: ${error.message}`
                });
            }
            
            return;
        }
        
        // Cancel Match command (Admin only)
        if (commandName === 'cancel-match') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const matchId = interaction.options.getString('match-id');
            const teams = interaction.options.getString('teams');
            const dateStr = interaction.options.getString('date');
            
            try {
                // If match ID is provided, cancel that specific match
                if (matchId) {
                    const cancelledMatch = await db.cancelMatch(matchId);
                    
                    const embed = createEmbed('Match Cancelled', 
                        `✅ **${cancelledMatch.team1} vs ${cancelledMatch.team2}** has been cancelled.\n\n` +
                        `📅 **Was scheduled for**: ${new Date(cancelledMatch.dateTime).toLocaleDateString()} at ${new Date(cancelledMatch.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n` +
                        (cancelledMatch.description ? `📝 **Description**: ${cancelledMatch.description}\n` : '') +
                        `\n🗑️ Match removed from calendar.`, 
                        config.colors.success);
                    
                    await interaction.reply({ embeds: [embed] });
                    return;
                }
                
                // Otherwise, show matches to cancel (filtered if criteria provided)
                const matchesToCancel = await db.findMatches(teams, dateStr);
                
                if (matchesToCancel.length === 0) {
                    let message = 'No upcoming matches found';
                    if (teams || dateStr) {
                        message += ' matching your criteria';
                    }
                    message += '. Use `/match-calendar` to see all scheduled matches.';
                    
                    await interaction.reply({
                        content: message,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                
                const embed = createCancelMatchEmbed(matchesToCancel);
                await interaction.reply({ embeds: [embed] });
                
            } catch (error) {
                console.error('Error cancelling match:', error);
                
                if (error.message === 'Match not found') {
                    await interaction.reply({
                        content: 'Match not found. It may have already been cancelled or the ID is incorrect. Use `/cancel-match` to see available matches.',
                        flags: MessageFlags.Ephemeral
                    });
                } else {
                    await interaction.reply({
                        content: `Error cancelling match: ${error.message}`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            }
            
            return;
        }
        
        // Compare command - Player comparison
        if (commandName === 'compare') {
            const player1User = interaction.options.getUser('player1');
            const player2User = interaction.options.getUser('player2');
            
            // Get both players from database
            const player1 = await db.getPlayer(player1User.id);
            const player2 = await db.getPlayer(player2User.id);
            
            if (!player1) {
                await interaction.reply({ 
                    content: `${player1User.username} is not registered yet.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            if (!player2) {
                await interaction.reply({ 
                    content: `${player2User.username} is not registered yet.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const embed = createPlayerComparisonEmbed(player1, player2, player1User, player2User);
            await interaction.reply({ embeds: [embed] });
            return;
        }
        
        // Recent command - Recent form tracking
        if (commandName === 'recent') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const gamesRequested = interaction.options.getInteger('games') || 10;
            
            // Get player from database
            const player = await db.getPlayer(targetUser.id);
            
            if (!player) {
                await interaction.reply({ 
                    content: `${targetUser.username} is not registered yet.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            // Get recent games
            const recentGames = await db.getRecentGames(targetUser.id, gamesRequested);
            
            const embed = createRecentFormEmbed(player, recentGames, gamesRequested);
            await interaction.reply({ embeds: [embed] });
            return;
        }
        
        // My Stats command - Personal dashboard
        if (commandName === 'my-stats') {
            const userId = interaction.user.id;
            
            // Get player from database
            const player = await db.getPlayer(userId);
            
            if (!player) {
                await interaction.reply({ 
                    content: `You are not registered yet. An admin can register you with the \`/register\` command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            // Get recent games and achievement progress
            const recentGames = await db.getRecentGames(userId, 5);
            const achievementProgress = calculateAchievementProgress(player);
            
            const embed = createPersonalDashboardEmbed(player, recentGames, achievementProgress);
            
            // Add user avatar if available
            if (interaction.user.avatar) {
                embed.setThumbnail(interaction.user.displayAvatarURL());
            }
            
            await interaction.reply({ embeds: [embed] });
            return;
        }
        
        // Schedule Match command (Admin only)
        if (commandName === 'schedule-match') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const team1 = interaction.options.getString('team1').trim();
            const team2 = interaction.options.getString('team2').trim();
            const dateTimeStr = interaction.options.getString('datetime');
            const description = interaction.options.getString('description') || '';
            
            // Check if teams are different (case insensitive)
            if (team1.toLowerCase() === team2.toLowerCase()) {
                await interaction.reply({
                    content: 'Cannot schedule a match between the same team!',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                // Parse the date/time
                const matchDateTime = parseMatchDateTime(dateTimeStr);
                
                // Check if date is in the future
                if (matchDateTime <= new Date()) {
                    await interaction.reply({
                        content: 'Match date must be in the future!',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                
                // Schedule the match
                const scheduledMatch = await db.scheduleMatch(team1, team2, matchDateTime.toISOString(), description);
                
                const embed = createEmbed('Match Scheduled', 
                    `🗓️ **${team1} vs ${team2}**\n\n` +
                    `📅 **Date**: ${matchDateTime.toLocaleDateString()}\n` +
                    `⏰ **Time**: ${matchDateTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n` +
                    (description ? `📝 **Description**: ${description}\n` : '') +
                    `\n✅ Match has been scheduled successfully!\n\n` +
                    `💡 **Note**: You can schedule matches against any team (A-Team, B-Team, or external teams like ATG, etc.)`, 
                    config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                await interaction.reply({
                    content: `Error scheduling match: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // Match Calendar command
        if (commandName === 'match-calendar') {
            try {
                // Clean up old matches first
                await db.cleanupOldMatches();
                
                // Get upcoming matches
                const upcomingMatches = await db.getUpcomingMatches(10);
                
                const embed = createMatchCalendarEmbed(upcomingMatches);
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error getting match calendar:', error);
                await interaction.reply({
                    content: `Error retrieving match calendar: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }

        // Achievements command
        if (commandName === 'achievements') {
            const embed = createAchievementsEmbed();
            await interaction.reply({ embeds: [embed] });
            return;
        }
        
        // Stats command
        if (commandName === 'stats') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const userId = targetUser.id;
            
            // Get the player from database
            let player = await db.getPlayer(userId);
            
            if (!player) {
                await interaction.reply({ 
                    content: `${targetUser.username} is not registered yet. An admin can register them with the \`/register\` command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            // Create the stats embed
            const embed = playerStatsEmbed(player);
            
            // Add user avatar if available
            if (targetUser.avatar) {
                embed.setThumbnail(targetUser.displayAvatarURL());
            }
            
            await interaction.reply({ embeds: [embed] });
            return;
        }
        
        // Team command (player leaderboard)
        if (commandName === 'team') {
            const teamName = interaction.options.getString('team');
            
            // Get all players for the team
            const players = await db.getAllPlayers(teamName);
            
            if (players.length === 0) {
                await interaction.reply({ 
                    content: `No players found for ${teamName}. Use \`/register\` to add players to this team.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            // Create the team stats embed
            const embed = teamLeaderboardEmbed(players, teamName);
            
            await interaction.reply({ embeds: [embed] });
            return;
        }
        
        // Team stats command (wins/losses)
        if (commandName === 'team-stats') {
            const teamName = interaction.options.getString('team');
            
            // Get team stats
            const teamStats = await db.getTeamStats(teamName);
            
            // Create the team stats embed
            const embed = teamStatsEmbed(teamName, teamStats);
            
            await interaction.reply({ embeds: [embed] });
            return;
        }
        
        // Leaderboard command
        if (commandName === 'leaderboard') {
            // Get all players from both teams
            const players = await db.getAllPlayers();
            
            if (players.length === 0) {
                await interaction.reply({ 
                    content: `No players registered yet. Use \`/register\` to add players.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            // Create the leaderboard embed
            const embed = createEmbed('Overall Leaderboard', 'Top players across all teams');
            
            // Sort by goals, assists, and MVPs
            let topScorers = [...players].sort((a, b) => b.goals - a.goals).slice(0, 5);
            let topAssists = [...players].sort((a, b) => b.assists - a.assists).slice(0, 5);
            let topMVPs = [...players].sort((a, b) => b.mvps - a.mvps).slice(0, 5);
            
            // Format the top scorers list
            let scorersText = '';
            topScorers.forEach((player, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                scorersText += `${medal} **${player.displayName}** (${player.team}): ${player.goals} goals\n`;
            });
            
            // Format the top assists list
            let assistsText = '';
            topAssists.forEach((player, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                assistsText += `${medal} **${player.displayName}** (${player.team}): ${player.assists} assists\n`;
            });
            
            // Format the top MVPs list
            let mvpsText = '';
            topMVPs.forEach((player, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                mvpsText += `${medal} **${player.displayName}** (${player.team}): ${player.mvps} MVPs\n`;
            });
            
            embed.addFields(
                { name: '⚽ Top Goal Scorers', value: scorersText || 'No data', inline: false },
                { name: '👟 Top Assist Providers', value: assistsText || 'No data', inline: false },
                { name: '🏆 Top MVP Winners', value: mvpsText || 'No data', inline: false }
            );
            
            await interaction.reply({ embeds: [embed] });
            return;
        }
        
        // Register command (Admin only)
        if (commandName === 'register') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const targetUser = interaction.options.getUser('user');
            const team = interaction.options.getString('team');
            
            // Check if player already exists
            let player = await db.getPlayer(targetUser.id);
            
            if (player) {
                // Update team if needed
                const players = await db.readPlayersFile();
                const playerIndex = players.findIndex(p => p.discordId === targetUser.id);
                
                if (players[playerIndex].team !== team) {
                    players[playerIndex].team = team;
                    players[playerIndex].updatedAt = new Date().toISOString();
                    await db.writePlayersFile(players);
                    
                    await interaction.reply({
                        content: `${targetUser.username} has been moved to ${team}.`,
                        ephemeral: false
                    });
                } else {
                    await interaction.reply({ 
                        content: `${targetUser.username} is already registered to ${team}.`,
                        ephemeral: false
                    });
                }
                return;
            }
            
            // Get display name
            const displayName = await getDisplayName(targetUser.id, interaction);
            
            // Create new player
            try {
                player = await db.createPlayer(targetUser.id, displayName, team);
                
                const embed = createEmbed('Player Registered', 
                    `✅ **${displayName}** has been registered to **${team}**!`, 
                    config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error registering player:', error);
                
                await interaction.reply({ 
                    content: `Error registering player: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // Add stats command (Admin only) - Updated to remove demos
        if (commandName === 'addstats') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const targetUser = interaction.options.getUser('user');
            
            // Get stats from options - REMOVED DEMOS
            const stats = {
                gamesPlayed: interaction.options.getInteger('games') || 0,
                goals: interaction.options.getInteger('goals') || 0,
                assists: interaction.options.getInteger('assists') || 0,
                saves: interaction.options.getInteger('saves') || 0,
                shots: interaction.options.getInteger('shots') || 0,
                mvps: interaction.options.getInteger('mvps') || 0
            };
            
            // Check if any stats were provided
            const totalStats = Object.values(stats).reduce((sum, val) => sum + val, 0);
            if (totalStats === 0) {
                await interaction.reply({ 
                    content: 'Please provide at least one stat to add.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            // Check if player exists
            let player = await db.getPlayer(targetUser.id);
            
            if (!player) {
                await interaction.reply({ 
                    content: `${targetUser.username} is not registered yet. Use \`/register\` first.`,
                    ephemeral: false
                });
                return;
            }
            
            // Update stats
            try {
                const updatedPlayer = await db.updatePlayerStats(targetUser.id, stats);
                
                // Add game record for recent form tracking if games were added
                if (stats.gamesPlayed > 0) {
                    await db.addGameRecord(targetUser.id, {
                        goals: Math.round(stats.goals / stats.gamesPlayed) || 0,
                        assists: Math.round(stats.assists / stats.gamesPlayed) || 0,
                        saves: Math.round(stats.saves / stats.gamesPlayed) || 0,
                        shots: Math.round(stats.shots / stats.gamesPlayed) || 0,
                        mvps: stats.mvps
                    });
                }
                
                // Build description of what was added - REMOVED DEMOS
                let description = `Stats added for **${updatedPlayer.displayName}**:\n\n`;
                if (stats.gamesPlayed > 0) description += `🎮 **Games**: +${stats.gamesPlayed}\n`;
                if (stats.goals > 0) description += `⚽ **Goals**: +${stats.goals}\n`;
                if (stats.assists > 0) description += `👟 **Assists**: +${stats.assists}\n`;
                if (stats.saves > 0) description += `🧤 **Saves**: +${stats.saves}\n`;
                if (stats.shots > 0) description += `🎯 **Shots**: +${stats.shots}\n`;
                if (stats.mvps > 0) description += `🏆 **MVPs**: +${stats.mvps}\n`;
                
                description += `\n**New Totals**:\n`;
                description += `🎮 Games: ${updatedPlayer.gamesPlayed} | `;
                description += `⚽ Goals: ${updatedPlayer.goals} | `;
                description += `👟 Assists: ${updatedPlayer.assists} | `;
                description += `🧤 Saves: ${updatedPlayer.saves} | `;
                description += `🎯 Shots: ${updatedPlayer.shots || 0} | `;
                description += `🏆 MVPs: ${updatedPlayer.mvps}`;
                
                const embed = createEmbed('Stats Added', description, config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error adding stats:', error);
                
                await interaction.reply({ 
                    content: `Error adding stats: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // Remove stats command (Admin only) - Updated to remove demos
        if (commandName === 'removestats') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const targetUser = interaction.options.getUser('user');
            
            // Get stats from options - REMOVED DEMOS
            const stats = {
                gamesPlayed: interaction.options.getInteger('games') || 0,
                goals: interaction.options.getInteger('goals') || 0,
                assists: interaction.options.getInteger('assists') || 0,
                saves: interaction.options.getInteger('saves') || 0,
                shots: interaction.options.getInteger('shots') || 0,
                mvps: interaction.options.getInteger('mvps') || 0
            };
            
            // Check if any stats were provided
            const totalStats = Object.values(stats).reduce((sum, val) => sum + val, 0);
            if (totalStats === 0) {
                await interaction.reply({ 
                    content: 'Please provide at least one stat to remove.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            // Check if player exists
            let player = await db.getPlayer(targetUser.id);
            
            if (!player) {
                await interaction.reply({ 
                    content: `${targetUser.username} is not registered yet. Use \`/register\` first.`,
                    ephemeral: false
                });
                return;
            }
            
            // Remove stats
            try {
                const updatedPlayer = await db.removePlayerStats(targetUser.id, stats);
                
                // Build description of what was removed - REMOVED DEMOS
                let description = `Stats removed from **${updatedPlayer.displayName}**:\n\n`;
                if (stats.gamesPlayed > 0) description += `🎮 **Games**: -${stats.gamesPlayed}\n`;
                if (stats.goals > 0) description += `⚽ **Goals**: -${stats.goals}\n`;
                if (stats.assists > 0) description += `👟 **Assists**: -${stats.assists}\n`;
                if (stats.saves > 0) description += `🧤 **Saves**: -${stats.saves}\n`;
                if (stats.shots > 0) description += `🎯 **Shots**: -${stats.shots}\n`;
                if (stats.mvps > 0) description += `🏆 **MVPs**: -${stats.mvps}\n`;
                
                description += `\n**New Totals**:\n`;
                description += `🎮 Games: ${updatedPlayer.gamesPlayed} | `;
                description += `⚽ Goals: ${updatedPlayer.goals} | `;
                description += `👟 Assists: ${updatedPlayer.assists} | `;
                description += `🧤 Saves: ${updatedPlayer.saves} | `;
                description += `🎯 Shots: ${updatedPlayer.shots || 0} | `;
                description += `🏆 MVPs: ${updatedPlayer.mvps}`;
                
                const embed = createEmbed('Stats Removed', description, config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error removing stats:', error);
                
                await interaction.reply({ 
                    content: `Error removing stats: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }

        // Team win command (Admin only)
        if (commandName === 'team-win') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const teamName = interaction.options.getString('team');
            const wins = interaction.options.getInteger('wins') || 1;
            
            try {
                const updatedStats = await db.updateTeamStats(teamName, wins, 0);
                
                const embed = createEmbed('Team Win Added', 
                    `🏆 **${teamName}** has been awarded ${wins} win${wins > 1 ? 's' : ''}!\n\n` +
                    `**Updated Record**: ${updatedStats.wins}-${updatedStats.losses}`, 
                    config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error adding team win:', error);
                
                await interaction.reply({ 
                    content: `Error adding team win: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // Team loss command (Admin only)
        if (commandName === 'team-loss') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const teamName = interaction.options.getString('team');
            const losses = interaction.options.getInteger('losses') || 1;
            
            try {
                const updatedStats = await db.updateTeamStats(teamName, 0, losses);
                
                const embed = createEmbed('Team Loss Added', 
                    `💀 **${teamName}** has been given ${losses} loss${losses > 1 ? 'es' : ''}.\n\n` +
                    `**Updated Record**: ${updatedStats.wins}-${updatedStats.losses}`, 
                    config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error adding team loss:', error);
                
                await interaction.reply({ 
                    content: `Error adding team loss: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }

        // Team remove win command (Admin only)
        if (commandName === 'team-remove-win') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const teamName = interaction.options.getString('team');
            const wins = interaction.options.getInteger('wins') || 1;
            
            try {
                const updatedStats = await db.removeTeamStats(teamName, wins, 0);
                
                const embed = createEmbed('Team Wins Removed', 
                    `🔄 **${teamName}** has had ${wins} win${wins > 1 ? 's' : ''} removed.\n\n` +
                    `**Updated Record**: ${updatedStats.wins}-${updatedStats.losses}`, 
                    config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error removing team wins:', error);
                
                await interaction.reply({ 
                    content: `Error removing team wins: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }
        
        // Team remove loss command (Admin only)
        if (commandName === 'team-remove-loss') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const teamName = interaction.options.getString('team');
            const losses = interaction.options.getInteger('losses') || 1;
            
            try {
                const updatedStats = await db.removeTeamStats(teamName, 0, losses);
                
                const embed = createEmbed('Team Losses Removed', 
                    `🔄 **${teamName}** has had ${losses} loss${losses > 1 ? 'es' : ''} removed.\n\n` +
                    `**Updated Record**: ${updatedStats.wins}-${updatedStats.losses}`, 
                    config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error removing team losses:', error);
                
                await interaction.reply({ 
                    content: `Error removing team losses: ${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            return;
        }

        // Wipe player stats
        if (commandName === 'wipe-players') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const confirmation = interaction.options.getString('confirmation');
            
            // Check confirmation
            if (confirmation !== 'CONFIRM') {
                await interaction.reply({
                    content: '❌ **Confirmation failed!**\n\nTo wipe all player data, you must type exactly: `CONFIRM`\n\n⚠️ **This action is irreversible** (unless you have backups).',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                await interaction.deferReply();
                
                // Create backup before wiping
                await db.createBackup('pre-wipe-players');
                
                await db.writePlayersFile([]);
                await db.writeGameHistoryFile([]); // Also clear game history
                
                const embed = createEmbed('⚠️ Player Data Wiped', 
                    '🔥 **All player stats have been permanently deleted!**\n\n' +
                    '📊 **What was wiped:**\n' +
                    '• All player statistics\n' +
                    '• All game history records\n\n' +
                    '💾 **Safety backup created** before wiping data.\n' +
                    '🔄 Use `/list-backups` and `/restore-backup` if you need to undo this action.\n\n' +
                    '⚠️ **Team records were NOT affected.**', 
                    config.colors.error);
                
                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Error wiping players:', error);
                await interaction.editReply({
                    content: `❌ Error wiping player data: ${error.message}`
                });
            }
            return;
        }

        // Wipe team records
        if (commandName === 'wipe-teams') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const confirmation = interaction.options.getString('confirmation');
            
            // Check confirmation
            if (confirmation !== 'CONFIRM') {
                await interaction.reply({
                    content: '❌ **Confirmation failed!**\n\nTo wipe all team records, you must type exactly: `CONFIRM`\n\n⚠️ **This action is irreversible** (unless you have backups).',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                await interaction.deferReply();
                
                // Create backup before wiping
                await db.createBackup('pre-wipe-teams');
                
                // Reset all teams to 0-0 record
                const allTeams = await db.getAllTeams();
                const resetTeamStats = {};
                allTeams.forEach(team => {
                    resetTeamStats[team] = { wins: 0, losses: 0 };
                });
                
                await db.writeTeamStatsFile(resetTeamStats);
                
                let teamsResetList = '';
                allTeams.forEach(team => {
                    teamsResetList += `• ${team}: 0W-0L\n`;
                });
                
                const embed = createEmbed('⚠️ Team Records Wiped', 
                    '🔥 **All team win/loss records have been reset!**\n\n' +
                    '📊 **Teams reset:**\n' + teamsResetList + '\n' +
                    '💾 **Safety backup created** before wiping data.\n' +
                    '🔄 Use `/list-backups` and `/restore-backup` if you need to undo this action.\n\n' +
                    '⚠️ **Player stats were NOT affected.**', 
                    config.colors.error);
                
                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Error wiping teams:', error);
                await interaction.editReply({
                    content: `❌ Error wiping team data: ${error.message}`
                });
            }
            return;
        }

        // Wipe everything
        if (commandName === 'wipe-all') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            const confirmation = interaction.options.getString('confirmation');
            
            // Check confirmation - requires more specific confirmation for total wipe
            if (confirmation !== 'CONFIRM DELETE ALL') {
                await interaction.reply({
                    content: '❌ **Confirmation failed!**\n\nTo completely wipe ALL data, you must type exactly: `CONFIRM DELETE ALL`\n\n💀 **This will delete EVERYTHING:**\n• All player stats\n• All team records\n• All game history\n• All scheduled matches\n\n⚠️ **This action is irreversible** (unless you have backups).',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            
            try {
                await interaction.deferReply();
                
                // Create backup before wiping everything
                await db.createBackup('pre-wipe-all');
                
                // Reset all data files
                await db.writePlayersFile([]);
                await db.writeGameHistoryFile([]);
                await db.writeScheduledMatchesFile([]);
                
                // Reset to default teams (A-Team and B-Team)
                const defaultTeamStats = {
                    'A-Team': { wins: 0, losses: 0 },
                    'B-Team': { wins: 0, losses: 0 }
                };
                await db.writeTeamStatsFile(defaultTeamStats);
                
                const embed = createEmbed('💀 ALL DATA WIPED', 
                    '🔥 **COMPLETE RESET: Everything has been permanently deleted!**\n\n' +
                    '📊 **What was wiped:**\n' +
                    '• ❌ All player statistics\n' +
                    '• ❌ All team win/loss records\n' +
                    '• ❌ All game history\n' +
                    '• ❌ All scheduled matches\n' +
                    '• ❌ All custom teams\n\n' +
                    '🔄 **Reset to defaults:**\n' +
                    '• ✅ A-Team: 0W-0L\n' +
                    '• ✅ B-Team: 0W-0L\n\n' +
                    '💾 **Full backup created** before wiping all data.\n' +
                    '🔄 Use `/list-backups` and `/restore-backup` to restore if needed.\n\n' +
                    '🎮 **Your bot is now completely reset with default teams ready for fresh data.**', 
                    config.colors.error);
                
                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Error wiping all data:', error);
                await interaction.editReply({
                    content: `❌ Error wiping data: ${error.message}`
                });
            }
            return;
        }
        
    } catch (error) {
        // Global error handler for all command processing
        console.error(`Error processing command ${interaction.commandName}:`, error);
        
        // Log more detailed error information
        console.error('Full error details:', {
            name: error.name,
            message: error.message,
            stack: error.stack,
            code: error.code,
            command: interaction.commandName,
            user: interaction.user?.username,
            guild: interaction.guild?.name
        });
        
        try {
            // Try to inform the user that something went wrong
            const errorMessage = `An error occurred: ${error.message || 'Unknown error'}`;
                
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: errorMessage,
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (replyError) {
            console.error('Failed to send error message:', replyError);
        }
    }
});

// Add reconnection handlers
client.on('disconnect', (event) => {
    console.error(`Bot disconnected with code ${event.code}. Reason: ${event.reason}`);
});

client.on('reconnecting', () => {
    console.log('Bot is reconnecting...');
});

client.on('resumed', (replayed) => {
    console.log(`Bot connection resumed. ${replayed} events replayed.`);
});

client.on('error', (error) => {
    console.error('Discord client error:', error);
});

// Log in to Discord
console.log('Attempting to log in to Discord...');
client.login(process.env.DISCORD_TOKEN).then(() => {
    console.log('Successfully logged in to Discord');
}).catch(error => {
    console.error('Failed to log in to Discord:', error);
});

// Create team leaderboard embed
function teamLeaderboardEmbed(players, teamName) {
    const teamColor = teamName === 'A-Team' ? config.colors.aTeam : config.colors.bTeam;
    
    // Sort players by goals
    players.sort((a, b) => b.goals - a.goals);
    
    const embed = new EmbedBuilder()
        .setColor(teamColor)
        .setTitle(`${teamName} Leaderboard`)
        .setDescription(`Top players in ${teamName}`)
        .setFooter({ text: 'Stats Bot', iconURL: 'https://i.imgur.com/wSTFkRM.png' })
        .setTimestamp();
    
    // Add top goal scorers
    let goalScorers = '';
    players.slice(0, 5).forEach((player, index) => {
        goalScorers += `${index + 1}. **${player.displayName}**: ${player.goals} goals\n`;
    });
    
    // Sort by assists for assist leaders
    players.sort((a, b) => b.assists - a.assists);
    let assistLeaders = '';
    players.slice(0, 3).forEach((player, index) => {
        assistLeaders += `${index + 1}. **${player.displayName}**: ${player.assists} assists\n`;
    });
    
    // Sort by MVPs for MVP leaders
    players.sort((a, b) => b.mvps - a.mvps);
    let mvpLeaders = '';
    players.slice(0, 3).forEach((player, index) => {
        mvpLeaders += `${index + 1}. **${player.displayName}**: ${player.mvps} MVPs\n`;
    });
    
    embed.addFields(
        { name: '⚽ Top Goal Scorers', value: goalScorers || 'No data', inline: false },
        { name: '👟 Top Assist Providers', value: assistLeaders || 'No data', inline: false },
        { name: '🏆 MVP Leaders', value: mvpLeaders || 'No data', inline: false }
    );
    
    return embed;
}

// Create team stats embed (wins/losses)
function teamStatsEmbed(teamName, teamStats) {
    const teamColor = teamName === 'A-Team' ? config.colors.aTeam : config.colors.bTeam;
    const totalGames = teamStats.wins + teamStats.losses;
    const winRate = totalGames > 0 ? ((teamStats.wins / totalGames) * 100).toFixed(1) : '0.0';
    
    return new EmbedBuilder()
        .setColor(teamColor)
        .setTitle(`${teamName} Record`)
        .setDescription(`Win/Loss statistics for ${teamName}`)
        .addFields(
            { name: '🏆 Wins', value: teamStats.wins.toString(), inline: true },
            { name: '💀 Losses', value: teamStats.losses.toString(), inline: true },
            { name: '🎮 Total Games', value: totalGames.toString(), inline: true },
            { name: '📊 Win Rate', value: `${winRate}%`, inline: true },
            { name: '📈 Record', value: `${teamStats.wins}-${teamStats.losses}`, inline: true }
        )
        .setFooter({ text: 'Stats Bot', iconURL: 'https://i.imgur.com/wSTFkRM.png' })
        .setTimestamp();
}