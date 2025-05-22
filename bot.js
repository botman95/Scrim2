// Discord Stats Bot for tracking team statistics
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const PORT = process.env.PORT || 3000;
const csv = require('csv-parser');
const multer = require('multer');
const { AttachmentBuilder } = require('discord.js');

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
    nameMappingFilePath: path.join(__dirname, 'name-mapping.json')
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

    // Read name mapping file
    readNameMappingFile: async () => {
        try {
            // Ensure the file exists, create if not
            await fs.access(config.nameMappingFilePath).catch(async () => {
                await fs.writeFile(config.nameMappingFilePath, JSON.stringify({}));
            });

            const data = await fs.readFile(config.nameMappingFilePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading name mapping file:', error);
            return {};
        }
    },

    // Write name mapping data to file
    writeNameMappingFile: async (mapping) => {
        try {
            await fs.writeFile(config.nameMappingFilePath, JSON.stringify(mapping, null, 2));
        } catch (error) {
            console.error('Error writing name mapping file:', error);
        }
    },

    // Add name mapping
    addNameMapping: async (ingameName, discordId) => {
        const mapping = await db.readNameMappingFile();
        mapping[ingameName.toLowerCase()] = discordId;
        await db.writeNameMappingFile(mapping);
        return mapping;
    },

    // Remove name mapping
    removeNameMapping: async (ingameName) => {
        const mapping = await db.readNameMappingFile();
        delete mapping[ingameName.toLowerCase()];
        await db.writeNameMappingFile(mapping);
        return mapping;
    },

    // Get Discord ID from in-game name
    getDiscordIdFromIngameName: async (ingameName) => {
        const mapping = await db.readNameMappingFile();
        return mapping[ingameName.toLowerCase()] || null;
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

    // Create a new player - Updated to include shots and demos
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
            demos: 0,
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
    // Read imported games file
readImportedGamesFile: async () => {
    try {
        const importedGamesPath = path.join(__dirname, 'imported-games.json');
        await fs.access(importedGamesPath).catch(async () => {
            await fs.writeFile(importedGamesPath, JSON.stringify([]));
        });

        const data = await fs.readFile(importedGamesPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading imported games file:', error);
        return [];
    }
},

// Write imported games file
writeImportedGamesFile: async (games) => {
    try {
        const importedGamesPath = path.join(__dirname, 'imported-games.json');
        await fs.writeFile(importedGamesPath, JSON.stringify(games, null, 2));
    } catch (error) {
        console.error('Error writing imported games file:', error);
    }
},

// Check if a game was already imported
isGameAlreadyImported: async (timestamp, playerId) => {
    const importedGames = await db.readImportedGamesFile();
    const gameKey = `${timestamp}_${playerId}`;
    return importedGames.includes(gameKey);
},

// Mark a game as imported
markGameAsImported: async (timestamp, playerId) => {
    const importedGames = await db.readImportedGamesFile();
    const gameKey = `${timestamp}_${playerId}`;
    if (!importedGames.includes(gameKey)) {
        importedGames.push(gameKey);
        await db.writeImportedGamesFile(importedGames);
    }
}
};

// CSV parsing utility functions
const csvUtils = {
    // Parse CSV buffer and return player data from Rocket League stats format
    parsePlayerStats: async (csvBuffer) => {
        return new Promise((resolve, reject) => {
            const results = [];
            const stream = require('stream');
            
            const readable = new stream.Readable();
            readable.push(csvBuffer);
            readable.push(null);
            
            readable
                .pipe(csv({ 
                    headers: true,
                    trim: true,
                    mapHeaders: ({ header }) => header.trim()
                }))
                .on('data', (row) => {
                    // Skip duplicate header rows using the _0 column (first column)
                    if (row._0 === 'TEAM COLOR') {
                        console.log('Skipping duplicate header row');
                        return;
                    }
                    
                    // Skip empty rows
                    if (!row._0 || row._0.trim() === '') {
                        return;
                    }
                    
                    // Access data using the _0, _1, _2... column names
                    const cleanRow = {
                        playerName: row._1?.trim(),      // _1 = NAME column
                        teamColor: row._0?.trim(),       // _0 = TEAM COLOR column  
                        goals: parseInt(row._2) || 0,    // _2 = GOALS column
                        assists: parseInt(row._3) || 0,  // _3 = ASSISTS column
                        saves: parseInt(row._4) || 0,    // _4 = SAVES column
                        shots: parseInt(row._5) || 0,    // _5 = SHOTS column
                        demos: parseInt(row._6) || 0,    // _6 = DEMOS column
                        score: parseInt(row._7) || 0,    // _7 = SCORE column (ADD this line)
                        winLoss: row._10?.trim(),        // _10 = W/L column
                        timestamp: row._11?.trim(),      // _11 = TIMESTAMP column
                        playerId: row._12?.trim()        // _12 = PLAYERID column
                    };
                    
                    console.log('Cleaned row:', {
                        playerName: cleanRow.playerName,
                        teamColor: cleanRow.teamColor,
                        winLoss: cleanRow.winLoss
                    });
                    
                    // Validate required fields
                    if (cleanRow.playerName && 
                        cleanRow.teamColor && 
                        cleanRow.winLoss &&
                        cleanRow.playerName !== '' &&
                        cleanRow.teamColor !== '' &&
                        cleanRow.winLoss !== '') {
                        console.log('✅ Valid row added');
                        results.push(cleanRow);
                    } else {
                        console.log('❌ Row failed validation');
                    }
                })
                .on('end', () => {
                    console.log(`Debug summary: ${results.length} valid rows found`);
                    resolve(results);
                })
                .on('error', (error) => {
                    console.error('CSV parsing error:', error);
                    reject(error);
                });
        });
    },

    // Validate CSV data structure
    validateCsvData: (data) => {
        const errors = [];
        const validWinLoss = ['WIN', 'LOSS', 'win', 'loss'];
        const validTeamColors = ['Orange', 'Blue', 'orange', 'blue'];
        
        data.forEach((row, index) => {
            // Check if player name exists
            if (!row.playerName) {
                errors.push(`Row ${index + 1}: Missing player name`);
            }
            
            // Check if team color is valid
            if (!validTeamColors.includes(row.teamColor)) {
                errors.push(`Row ${index + 1}: Invalid team color "${row.teamColor}". Must be "Orange" or "Blue"`);
            }
            
            // Check if W/L is valid
            if (!validWinLoss.includes(row.winLoss)) {
                errors.push(`Row ${index + 1}: Invalid W/L value "${row.winLoss}". Must be "WIN" or "LOSS"`);
            }
            
            // Check for negative stats
            const stats = ['goals', 'assists', 'saves', 'shots', 'demos'];
            stats.forEach(stat => {
                if (row[stat] < 0) {
                    errors.push(`Row ${index + 1}: ${stat} cannot be negative`);
                }
            });
        });
        
        return errors;
    },

    // Process game data and aggregate by player
    aggregatePlayerStats: async (gameData) => {
        const playerStats = {};
        const newGamesCount = { total: 0, duplicates: 0 };
        
        // Group games by timestamp to identify unique matches
        const gamesByMatch = {};
        
        for (const row of gameData) {
            const playerKey = row.playerName.toLowerCase();
            
            // Check if this specific game was already imported
            const isAlreadyImported = await db.isGameAlreadyImported(row.timestamp, row.playerId);
            
            if (isAlreadyImported) {
                console.log(`Skipping duplicate game: ${row.playerName} at ${row.timestamp}`);
                newGamesCount.duplicates++;
                continue;
            }
            
            // Mark this game as imported
            await db.markGameAsImported(row.timestamp, row.playerId);
            newGamesCount.total++;
            
            // Group by match timestamp to find MVPs later
            if (!gamesByMatch[row.timestamp]) {
                gamesByMatch[row.timestamp] = [];
            }
            gamesByMatch[row.timestamp].push(row);
            
            if (!playerStats[playerKey]) {
                playerStats[playerKey] = {
                    playerName: row.playerName,
                    totalGames: 0,
                    wins: 0,
                    losses: 0,
                    totalGoals: 0,
                    totalAssists: 0,
                    totalSaves: 0,
                    totalShots: 0,
                    totalDemos: 0,
                    totalMvps: 0,  // Track MVPs
                    lastSeen: row.timestamp,
                    playerId: row.playerId
                };
            }
            
            const player = playerStats[playerKey];
            
            // Add stats from this NEW game
            player.totalGames++;
            player.totalGoals += row.goals;
            player.totalAssists += row.assists;
            player.totalSaves += row.saves;
            player.totalShots += row.shots;
            player.totalDemos += row.demos;
            
            // Track wins/losses
            if (row.winLoss.toUpperCase() === 'WIN') {
                player.wins++;
            } else if (row.winLoss.toUpperCase() === 'LOSS') {
                player.losses++;
            }
            
            // Update last seen timestamp
            if (row.timestamp && (!player.lastSeen || row.timestamp > player.lastSeen)) {
                player.lastSeen = row.timestamp;
            }
        }
        
        // NEW: Calculate MVPs for each match
        for (const [timestamp, matchPlayers] of Object.entries(gamesByMatch)) {
            // Find winning team
            const winningPlayers = matchPlayers.filter(p => p.winLoss.toUpperCase() === 'WIN');
            
            if (winningPlayers.length > 0) {
                // Find highest scoring player on winning team
                const mvpPlayer = winningPlayers.reduce((highest, current) => {
                    const currentScore = parseInt(current.score) || 0;
                    const highestScore = parseInt(highest.score) || 0;
                    return currentScore > highestScore ? current : highest;
                });
                
                // Award MVP
                const mvpKey = mvpPlayer.playerName.toLowerCase();
                if (playerStats[mvpKey]) {
                    playerStats[mvpKey].totalMvps++;
                    console.log(`MVP awarded to ${mvpPlayer.playerName} (Score: ${mvpPlayer.score}) in match at ${timestamp}`);
                }
            }
        }
        
        // Add metadata about import
        const result = Object.values(playerStats);
        result.importSummary = newGamesCount;
        return result;
    },

    // Map player names to Discord users using the mapping system
    mapPlayersToDiscord: async (aggregatedStats, interaction) => {
        const mappedPlayers = [];
        const unmappedPlayers = [];
        
        for (const playerStats of aggregatedStats) {
            // First try the name mapping system
            let discordId = await db.getDiscordIdFromIngameName(playerStats.playerName);
            let displayName = playerStats.playerName;
            
            if (discordId) {
                // Found in mapping system, get display name
                try {
                    const member = await interaction.guild.members.fetch(discordId);
                    displayName = member.displayName;
                    
                    mappedPlayers.push({
                        discordId,
                        displayName,
                        ...playerStats
                    });
                    continue;
                } catch (error) {
                    console.error(`Error fetching mapped user ${discordId}:`, error);
                    // Fall through to auto-matching
                }
            }
            
            // Try auto-matching by searching guild members for matching display names
            try {
                const members = await interaction.guild.members.fetch();
                const matchedMember = members.find(member => 
                    member.displayName.toLowerCase() === playerStats.playerName.toLowerCase() ||
                    member.user.username.toLowerCase() === playerStats.playerName.toLowerCase()
                );
                
                if (matchedMember) {
                    mappedPlayers.push({
                        discordId: matchedMember.id,
                        displayName: matchedMember.displayName,
                        ...playerStats
                    });
                } else {
                    unmappedPlayers.push(playerStats);
                }
            } catch (error) {
                console.error(`Error mapping player ${playerStats.playerName}:`, error);
                unmappedPlayers.push(playerStats);
            }
        }
        
        return { mappedPlayers, unmappedPlayers };
    },

    // Generate CSV template for Rocket League stats
    generateCsvTemplate: () => {
        const headers = 'TEAM COLOR,NAME,GOALS,ASSISTS,SAVES,SHOTS,DEMOS,SCORE,MMR,TEAM GOALS,W/L,TIMESTAMP,PLAYERID\n';
        const exampleRows = [
            'Orange,Sweapiin,2,1,0,2,1,390,1465.8,3,WIN,05/22/2025 19:47,Epic|d7b1a2f9cc8443e495d0b40e2fee9bc9|0',
            'Orange,Blood_Red_Haze,1,2,3,6,2,682,1614.07,3,WIN,05/22/2025 19:47,Steam|76561198336920805|0',
            'Blue,xtturl,1,1,2,3,1,476,0,2,LOSS,05/22/2025 19:47,Epic|44661ec598414759a45022789576bfea|0',
            'Blue,Natbar70.,1,1,3,3,0,571,0,2,LOSS,05/22/2025 19:47,Epic|c1547ade71b3404e87dc945a4c73012b|0'
        ];
        return headers + exampleRows.join('\n');
    },

    // Clean up uploaded CSV file
    cleanupFile: async (filePath) => {
        try {
            await fs.unlink(filePath);
            console.log(`Successfully deleted file: ${filePath}`);
        } catch (error) {
            console.error(`Error deleting file ${filePath}:`, error);
        }
    }
};

// Achievements definition (updated to include shots and demos)
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
    demos: [
        { threshold: 10, name: 'Demolisher', emoji: '💥', description: 'Get 10+ demos' },
        { threshold: 25, name: 'Wrecking Ball', emoji: '🏗️', description: 'Get 25+ demos' },
        { threshold: 50, name: 'Destructor', emoji: '💀', description: 'Get 50+ demos' }
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

// Define slash commands - Complete with all features
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
        .setName('link-player')
        .setDescription('Link an in-game name to a Discord user (Admin only)')
        .addUserOption(option =>
            option.setName('discord-user')
                .setDescription('Discord user to link')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('ingame-name')
                .setDescription('In-game name (case sensitive)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('unlink-player')
        .setDescription('Remove link between in-game name and Discord user (Admin only)')
        .addStringOption(option =>
            option.setName('ingame-name')
                .setDescription('In-game name to unlink')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('show-links')
        .setDescription('Show all current player name mappings'),

    new SlashCommandBuilder()
        .setName('import-game-stats')
        .setDescription('Import Rocket League game stats from CSV file (Admin only)')
        .addAttachmentOption(option =>
            option.setName('file')
                .setDescription('CSV file containing Rocket League game statistics')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('team-assignment')
                .setDescription('How to assign players to teams')
                .setRequired(false)
                .addChoices(
                    { name: 'Orange = A-Team, Blue = B-Team', value: 'orange-a' },
                    { name: 'Orange = B-Team, Blue = A-Team', value: 'orange-b' },
                    { name: 'Manual assignment later', value: 'manual' }
                )),

    new SlashCommandBuilder()
        .setName('rl-csv-template')
        .setDescription('Get a Rocket League CSV template file for importing stats'),
    
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
        .addIntegerOption(option => createIntegerOption(option, 'demos', 'Number of demos to add', false))
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
        .addIntegerOption(option => createIntegerOption(option, 'demos', 'Number of demos to remove', false))
        .addIntegerOption(option => createIntegerOption(option, 'mvps', 'Number of MVPs to remove', false)),
        
    new SlashCommandBuilder()
    .setName('wipe-players')
    .setDescription('DANGER: Wipe all player stats (Admin only)'),

new SlashCommandBuilder()
    .setName('wipe-teams')
    .setDescription('DANGER: Reset all team records (Admin only)'),

new SlashCommandBuilder()
    .setName('wipe-imports')
    .setDescription('Reset import history (allows re-importing same games)'),

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
        .setName('export-csv')
        .setDescription('Export current player stats to CSV format')
        .addStringOption(option =>
            option.setName('team')
                .setDescription('Export specific team only (optional)')
                .setRequired(false)
                .addChoices(
                    { name: 'A-Team', value: 'A-Team' },
                    { name: 'B-Team', value: 'B-Team' }
                ))
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
            // Get your app URL from environment variable
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
    
    return embed;
}

// Create player stats embed (updated to include shots and demos)
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
            { name: '💥 Demos', value: (player.demos || 0).toString(), inline: true },
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
        // Basic Commands Section
        { name: '📊 **Basic Commands**', value: '\u200B', inline: false },
        { name: '/help', value: 'Shows this help message', inline: true },
        { name: '/stats [user]', value: 'Shows stats for a user (or yourself if no user specified)', inline: true },
        { name: '/leaderboard', value: 'Shows the overall leaderboard across both teams', inline: true },
        
        // Team Commands Section  
        { name: '🏆 **Team Commands**', value: '\u200B', inline: false },
        { name: '/team <team>', value: 'Shows player leaderboard for a specific team', inline: true },
        { name: '/team-stats <team>', value: 'Shows win/loss record for a specific team', inline: true },
        { name: '/achievements', value: 'Shows all available achievements and how to unlock them', inline: true },
        
        // Utility Commands Section
        { name: '🔧 **Utility Commands**', value: '\u200B', inline: false },
        { name: '/show-links', value: 'Shows all current player name mappings', inline: true },
        { name: '/rl-csv-template', value: 'Get a Rocket League CSV template file', inline: true },
        { name: '\u200B', value: '\u200B', inline: true }, // Empty field for spacing
        
        // Admin Commands Section
        { name: '⚙️ **Admin Commands**', value: 'The following commands require the Scrimster role:', inline: false },
        
        // Player Management
        { name: '👥 *Player Management*', value: '\u200B', inline: false },
        { name: '/register <user> <team>', value: 'Register a new player to a team', inline: true },
        { name: '/link-player <user> <name>', value: 'Link an in-game name to a Discord user', inline: true },
        { name: '/unlink-player <name>', value: 'Remove player name mapping', inline: true },
        
        // Stats Management
        { name: '📈 *Stats Management*', value: '\u200B', inline: false },
        { name: '/addstats <user> [stats...]', value: 'Add stats for a player', inline: true },
        { name: '/removestats <user> [stats...]', value: 'Remove stats from a player', inline: true },
        { name: '/import-game-stats <file>', value: 'Import Rocket League stats from CSV', inline: true },
        
        // Team Record Management
        { name: '🏅 *Team Record Management*', value: '\u200B', inline: false },
        { name: '/team-win <team> [wins]', value: 'Add win(s) to a team record', inline: true },
        { name: '/team-loss <team> [losses]', value: 'Add loss(es) to a team record', inline: true },
        { name: '/team-remove-win <team> [wins]', value: 'Remove win(s) from a team record', inline: true },
        { name: '/team-remove-loss <team> [losses]', value: 'Remove loss(es) from a team record', inline: true },
        { name: '/export-csv [team]', value: 'Export player stats to CSV file', inline: true },
        { name: '\u200B', value: '\u200B', inline: true }, // Empty field for spacing
        
        // Dangerous Commands Section
        { name: '⚠️ **DANGER ZONE - Data Reset Commands**', value: 'Use with extreme caution!', inline: false },
        { name: '/wipe-players', value: '🔥 Wipe all player stats', inline: true },
        { name: '/wipe-teams', value: '🔥 Reset all team records', inline: true },
        { name: '/wipe-imports', value: '🔄 Clear import history', inline: true },
        { name: '/wipe-all', value: '💀 **COMPLETE RESET** - Wipes everything!', inline: true }
    );
    
    await interaction.reply({ embeds: [embed] });
    return;
}

        // Link player command (Admin only)
        if (commandName === 'link-player') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    ephemeral: true 
                });
                return;
            }

            const targetUser = interaction.options.getUser('discord-user');
            const ingameName = interaction.options.getString('ingame-name');

            try {
                // Check if the Discord user is registered
                const player = await db.getPlayer(targetUser.id);
                if (!player) {
                    await interaction.reply({
                        content: `${targetUser.username} is not registered yet. Use \`/register\` first.`,
                        ephemeral: true
                    });
                    return;
                }

                // Check if the in-game name is already linked
                const existingDiscordId = await db.getDiscordIdFromIngameName(ingameName);
                if (existingDiscordId && existingDiscordId !== targetUser.id) {
                    const existingPlayer = await db.getPlayer(existingDiscordId);
                    await interaction.reply({
                        content: `In-game name "${ingameName}" is already linked to ${existingPlayer?.displayName || 'another user'}. Use \`/unlink-player\` first if you want to reassign it.`,
                        ephemeral: true
                    });
                    return;
                }

                await db.addNameMapping(ingameName, targetUser.id);

                const embed = createEmbed('Player Linked', 
                    `✅ Successfully linked **${ingameName}** to **${targetUser.username}**!`, 
                    config.colors.success);

                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error linking player:', error);
                await interaction.reply({
                    content: `Error linking player: ${error.message}`,
                    ephemeral: true
                });
            }
            return;
        }

        // Unlink player command (Admin only)
        if (commandName === 'unlink-player') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    ephemeral: true 
                });
                return;
            }

            const ingameName = interaction.options.getString('ingame-name');

            try {
                const existingDiscordId = await db.getDiscordIdFromIngameName(ingameName);
                if (!existingDiscordId) {
                    await interaction.reply({
                        content: `In-game name "${ingameName}" is not currently linked to any Discord user.`,
                        ephemeral: true
                    });
                    return;
                }

                await db.removeNameMapping(ingameName);

                const embed = createEmbed('Player Unlinked', 
                    `✅ Successfully unlinked **${ingameName}** from Discord user!`, 
                    config.colors.success);

                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error unlinking player:', error);
                await interaction.reply({
                    content: `Error unlinking player: ${error.message}`,
                    ephemeral: true
                });
            }
            return;
        }

        // Show links command
        if (commandName === 'show-links') {
            try {
                const mapping = await db.readNameMappingFile();
                const mappingEntries = Object.entries(mapping);

                if (mappingEntries.length === 0) {
                    await interaction.reply({
                        content: 'No player name mappings currently configured. Use `/link-player` to create mappings.',
                        ephemeral: true
                    });
                    return;
                }

                const embed = createEmbed('Player Name Mappings', 'Current in-game name to Discord user mappings:');
                
                let mappingText = '';
                for (const [ingameName, discordId] of mappingEntries) {
                    try {
                        const member = await interaction.guild.members.fetch(discordId);
                        mappingText += `**${ingameName}** → ${member.displayName}\n`;
                    } catch (error) {
                        mappingText += `**${ingameName}** → <Unknown User>\n`;
                    }
                }

                embed.setDescription(mappingText);
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error showing links:', error);
                await interaction.reply({
                    content: `Error retrieving mappings: ${error.message}`,
                    ephemeral: true
                });
            }
            return;
        }

        // Import game stats command (Admin only)
        if (commandName === 'import-game-stats') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    ephemeral: true 
                });
                return;
            }

            const attachment = interaction.options.getAttachment('file');
            const teamAssignment = interaction.options.getString('team-assignment') || 'manual';

            // Validate file type
            if (!attachment.name.toLowerCase().endsWith('.csv')) {
                await interaction.reply({
                    content: 'Please upload a .csv file.',
                    ephemeral: true
                });
                return;
            }

            // Validate file size (limit to 5MB for game logs)
            if (attachment.size > 5 * 1024 * 1024) {
                await interaction.reply({
                    content: 'File too large. Please keep CSV files under 5MB.',
                    ephemeral: true
                });
                return;
            }

            let tempFilePath = null;

            try {
                // Defer reply since this might take a moment
                await interaction.deferReply();

                // Download the CSV file
                const response = await fetch(attachment.url);
                const csvBuffer = Buffer.from(await response.arrayBuffer());

                // Save to temporary file for cleanup later
                tempFilePath = path.join(__dirname, `temp_${Date.now()}_${attachment.name}`);
                await fs.writeFile(tempFilePath, csvBuffer);

                // Parse CSV data
                const csvData = await csvUtils.parsePlayerStats(csvBuffer);

                if (csvData.length === 0) {
                    await interaction.editReply({
                        content: 'No valid data found in CSV file. Please check the format.'
                    });
                    return;
                }

                // Validate CSV data
                const validationErrors = csvUtils.validateCsvData(csvData);
                if (validationErrors.length > 0) {
                    await interaction.editReply({
                        content: `CSV validation errors:\n${validationErrors.slice(0, 10).join('\n')}${validationErrors.length > 10 ? '\n... and more' : ''}`
                    });
                    return;
                }

                // Aggregate player stats from individual game records
                const aggregatedStats = await csvUtils.aggregatePlayerStats(csvData);
                const importSummary = aggregatedStats.importSummary;

                // Try to map players to Discord users
                const { mappedPlayers, unmappedPlayers } = await csvUtils.mapPlayersToDiscord(aggregatedStats, interaction);

                // Process mapped players
                let imported = 0;
                let updated = 0;
                let errors = [];
                const processedMatches = new Set(); // NEW: Track unique matches
                
                for (const playerData of mappedPlayers) {
                    try {
                        // Check if player exists in bot database
                        let existingPlayer = await db.getPlayer(playerData.discordId);
                
                        // Determine team assignment
                        let assignedTeam = null;
                        if (teamAssignment === 'orange-a') {
                            // Most recent team color determines assignment
                            const lastGame = csvData.filter(game => 
                                game.playerName.toLowerCase() === playerData.playerName.toLowerCase()
                            ).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
                            assignedTeam = lastGame?.teamColor?.toLowerCase() === 'orange' ? 'A-Team' : 'B-Team';
                        } else if (teamAssignment === 'orange-b') {
                            const lastGame = csvData.filter(game => 
                                game.playerName.toLowerCase() === playerData.playerName.toLowerCase()
                            ).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
                            assignedTeam = lastGame?.teamColor?.toLowerCase() === 'orange' ? 'B-Team' : 'A-Team';
                        } else {
                            // Manual assignment - use existing team or default to A-Team
                            assignedTeam = existingPlayer?.team || 'A-Team';
                        }
                
                        if (existingPlayer) {
                            // Update existing player stats
                            const stats = {
                                gamesPlayed: playerData.totalGames,
                                goals: playerData.totalGoals,
                                assists: playerData.totalAssists,
                                saves: playerData.totalSaves,
                                shots: playerData.totalShots,
                                demos: playerData.totalDemos,
                                mvps: playerData.totalMvps  // ADD this line
                            };
                        
                            await db.updatePlayerStats(playerData.discordId, stats);
                            updated++;
                        } else {
                            // Create new player
                            await db.createPlayer(playerData.discordId, playerData.displayName, assignedTeam);
                            
                            // Add stats
                            const stats = {
                                gamesPlayed: playerData.totalGames,
                                goals: playerData.totalGoals,
                                assists: playerData.totalAssists,
                                saves: playerData.totalSaves,
                                shots: playerData.totalShots,
                                demos: playerData.totalDemos,
                                mvps: playerData.totalMvps  // ADD this line
                            };
                            
                            await db.updatePlayerStats(playerData.discordId, stats);
                            imported++;
                        }
                
                        // NEW: Handle team wins/losses ONCE per unique match
                        const playerMatches = csvData.filter(game => 
                            game.playerName.toLowerCase() === playerData.playerName.toLowerCase()
                        );
                        
                        for (const match of playerMatches) {
                            // Create unique key: timestamp + team + result
                            const matchKey = `${match.timestamp}_${assignedTeam}_${match.winLoss}`;
                            
                            if (!processedMatches.has(matchKey)) {
                                processedMatches.add(matchKey);
                                
                                // Count this as ONE team win/loss (not per player)
                                if (match.winLoss.toUpperCase() === 'WIN') {
                                    await db.updateTeamStats(assignedTeam, 1, 0);
                                } else if (match.winLoss.toUpperCase() === 'LOSS') {
                                    await db.updateTeamStats(assignedTeam, 0, 1);
                                }
                            }
                        }
                        
                    } catch (error) {
                        errors.push(`Error processing ${playerData.playerName}: ${error.message}`);
                    }
                }

                // Create success embed
                const embed = createEmbed('Rocket League Stats Import Complete', null, config.colors.success);

                let description = `🚀 **Import Summary:**\n`;
                description += `✅ New games imported: ${importSummary.total}\n`;
                description += `🔄 Duplicate games skipped: ${importSummary.duplicates}\n`;
                description += `📊 Total game rows processed: ${csvData.length}\n`;
                description += `🎮 Unique players found: ${aggregatedStats.length - 1}\n`; // -1 because importSummary is included
                description += `🔗 Discord users matched: ${mappedPlayers.length}\n`;
                
                if (unmappedPlayers.length > 0) {
                    description += `❓ Unmatched players: ${unmappedPlayers.length}\n`;
                    description += `\n**Unmatched Players:**\n`;
                    unmappedPlayers.slice(0, 5).forEach(player => {
                        description += `• ${player.playerName} (${player.totalGames} games, ${player.totalGoals} goals)\n`;
                    });
                    if (unmappedPlayers.length > 5) {
                        description += `... and ${unmappedPlayers.length - 5} more\n`;
                    }
                    description += `\nUse \`/link-player\` to map these players to Discord users.\n`;
                }
                
                if (errors.length > 0) {
                    description += `\n❌ Errors: ${errors.length}\n`;
                    description += `**Error Details:**\n${errors.slice(0, 3).join('\n')}`;
                    if (errors.length > 3) {
                        description += `\n... and ${errors.length - 3} more errors`;
                    }
                }

                embed.setDescription(description);
                await interaction.editReply({ embeds: [embed] });

            } catch (error) {
                console.error('Error importing Rocket League CSV:', error);
                await interaction.editReply({
                    content: `Error importing CSV: ${error.message}`
                });
            } finally {
                // Clean up temporary file
                if (tempFilePath) {
                    try {
                        await csvUtils.cleanupFile(tempFilePath);
                    } catch (cleanupError) {
                        console.error('Error cleaning up file:', cleanupError);
                    }
                }
            }
            return;
        }

        // RL CSV Template command
        if (commandName === 'rl-csv-template') {
            try {
                const templateContent = csvUtils.generateCsvTemplate();
                const buffer = Buffer.from(templateContent, 'utf8');
                const attachment = new AttachmentBuilder(buffer, { name: 'rocket-league-stats-template.csv' });

                const embed = createEmbed('Rocket League CSV Template', 
                    '🚀 Here\'s a CSV template for importing Rocket League stats.\n\n' +
                    '**Required columns:**\n' +
                    '• `TEAM COLOR` - Either "Orange" or "Blue"\n' +
                    '• `NAME` - Player\'s in-game name\n' +
                    '• `GOALS` - Goals scored in the match\n' +
                    '• `ASSISTS` - Assists made in the match\n' +
                    '• `SAVES` - Saves made in the match\n' +
                    '• `SHOTS` - Shots taken in the match\n' +
                    '• `DEMOS` - Demolitions in the match\n' +
                    '• `W/L` - Either "WIN" or "LOSS"\n' +
                    '• `TIMESTAMP` - When the match occurred\n' +
                    '• Other columns (SCORE, MMR, etc.) are ignored\n\n' +
                    '**How it works:**\n' +
                    '• Each row represents one player in one match\n' +
                    '• The bot aggregates all matches per player\n' +
                    '• Uses name mapping system for Discord linking\n' +
                    '• Can assign teams based on Orange/Blue colors\n\n' +
                    'Use `/import-game-stats` to upload your completed file.',
                    config.colors.primary);

                await interaction.reply({ 
                    embeds: [embed],
                    files: [attachment]
                });

            } catch (error) {
                console.error('Error creating template:', error);
                await interaction.reply({
                    content: `Error creating template: ${error.message}`,
                    ephemeral: true
                });
            }
            return;
        }

        // Export CSV command
        if (commandName === 'export-csv') {
            try {
                await interaction.deferReply();

                const teamFilter = interaction.options.getString('team');
                const players = await db.getAllPlayers(teamFilter);

                if (players.length === 0) {
                    await interaction.editReply({
                        content: 'No players found to export.'
                    });
                    return;
                }

                // Generate CSV content (updated to include shots and demos)
                const headers = 'discordId,displayName,team,gamesPlayed,goals,assists,saves,shots,demos,mvps\n';
                const rows = players.map(player => 
                    `${player.discordId},${player.displayName},${player.team},${player.gamesPlayed},${player.goals},${player.assists},${player.saves},${player.shots || 0},${player.demos || 0},${player.mvps}`
                );
                
                const csvContent = headers + rows.join('\n');
                
                // Create attachment
                const buffer = Buffer.from(csvContent, 'utf8');
                const filename = teamFilter ? `${teamFilter.toLowerCase()}-stats.csv` : 'all-players-stats.csv';
                const attachment = new AttachmentBuilder(buffer, { name: filename });

                const embed = createEmbed('Stats Exported', 
                    `📊 Exported stats for ${players.length} player${players.length > 1 ? 's' : ''}${teamFilter ? ` from ${teamFilter}` : ''}.`,
                    config.colors.success);

                await interaction.editReply({ 
                    embeds: [embed],
                    files: [attachment]
                });

            } catch (error) {
                console.error('Error exporting CSV:', error);
                await interaction.editReply({
                    content: `Error exporting CSV: ${error.message}`
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
                    ephemeral: true
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
                    ephemeral: true
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
                    ephemeral: true
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
                    ephemeral: true 
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
                    ephemeral: true
                });
            }
            
            return;
        }
        
        // Add stats command (Admin only)
        if (commandName === 'addstats') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    ephemeral: true 
                });
                return;
            }
            
            const targetUser = interaction.options.getUser('user');
            
            // Get stats from options - INCLUDING SHOTS AND DEMOS
            const stats = {
                gamesPlayed: interaction.options.getInteger('games') || 0,
                goals: interaction.options.getInteger('goals') || 0,
                assists: interaction.options.getInteger('assists') || 0,
                saves: interaction.options.getInteger('saves') || 0,
                shots: interaction.options.getInteger('shots') || 0,
                demos: interaction.options.getInteger('demos') || 0,
                mvps: interaction.options.getInteger('mvps') || 0
            };
            
            // Check if any stats were provided
            const totalStats = Object.values(stats).reduce((sum, val) => sum + val, 0);
            if (totalStats === 0) {
                await interaction.reply({ 
                    content: 'Please provide at least one stat to add.',
                    ephemeral: true
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
                
                // Build description of what was added - INCLUDING SHOTS AND DEMOS
                let description = `Stats added for **${updatedPlayer.displayName}**:\n\n`;
                if (stats.gamesPlayed > 0) description += `🎮 **Games**: +${stats.gamesPlayed}\n`;
                if (stats.goals > 0) description += `⚽ **Goals**: +${stats.goals}\n`;
                if (stats.assists > 0) description += `👟 **Assists**: +${stats.assists}\n`;
                if (stats.saves > 0) description += `🧤 **Saves**: +${stats.saves}\n`;
                if (stats.shots > 0) description += `🎯 **Shots**: +${stats.shots}\n`;
                if (stats.demos > 0) description += `💥 **Demos**: +${stats.demos}\n`;
                if (stats.mvps > 0) description += `🏆 **MVPs**: +${stats.mvps}\n`;
                
                description += `\n**New Totals**:\n`;
                description += `🎮 Games: ${updatedPlayer.gamesPlayed} | `;
                description += `⚽ Goals: ${updatedPlayer.goals} | `;
                description += `👟 Assists: ${updatedPlayer.assists} | `;
                description += `🧤 Saves: ${updatedPlayer.saves} | `;
                description += `🎯 Shots: ${updatedPlayer.shots || 0} | `;
                description += `💥 Demos: ${updatedPlayer.demos || 0} | `;
                description += `🏆 MVPs: ${updatedPlayer.mvps}`;
                
                const embed = createEmbed('Stats Added', description, config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error adding stats:', error);
                
                await interaction.reply({ 
                    content: `Error adding stats: ${error.message}`,
                    ephemeral: true
                });
            }
            
            return;
        }
        
        // Remove stats command (Admin only)
        if (commandName === 'removestats') {
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    ephemeral: true 
                });
                return;
            }
            
            const targetUser = interaction.options.getUser('user');
            
            // Get stats from options - INCLUDING SHOTS AND DEMOS
            const stats = {
                gamesPlayed: interaction.options.getInteger('games') || 0,
                goals: interaction.options.getInteger('goals') || 0,
                assists: interaction.options.getInteger('assists') || 0,
                saves: interaction.options.getInteger('saves') || 0,
                shots: interaction.options.getInteger('shots') || 0,
                demos: interaction.options.getInteger('demos') || 0,
                mvps: interaction.options.getInteger('mvps') || 0
            };
            
            // Check if any stats were provided
            const totalStats = Object.values(stats).reduce((sum, val) => sum + val, 0);
            if (totalStats === 0) {
                await interaction.reply({ 
                    content: 'Please provide at least one stat to remove.',
                    ephemeral: true
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
                
                // Build description of what was removed - INCLUDING SHOTS AND DEMOS
                let description = `Stats removed from **${updatedPlayer.displayName}**:\n\n`;
                if (stats.gamesPlayed > 0) description += `🎮 **Games**: -${stats.gamesPlayed}\n`;
                if (stats.goals > 0) description += `⚽ **Goals**: -${stats.goals}\n`;
                if (stats.assists > 0) description += `👟 **Assists**: -${stats.assists}\n`;
                if (stats.saves > 0) description += `🧤 **Saves**: -${stats.saves}\n`;
                if (stats.shots > 0) description += `🎯 **Shots**: -${stats.shots}\n`;
                if (stats.demos > 0) description += `💥 **Demos**: -${stats.demos}\n`;
                if (stats.mvps > 0) description += `🏆 **MVPs**: -${stats.mvps}\n`;
                
                description += `\n**New Totals**:\n`;
                description += `🎮 Games: ${updatedPlayer.gamesPlayed} | `;
                description += `⚽ Goals: ${updatedPlayer.goals} | `;
                description += `👟 Assists: ${updatedPlayer.assists} | `;
                description += `🧤 Saves: ${updatedPlayer.saves} | `;
                description += `🎯 Shots: ${updatedPlayer.shots || 0} | `;
                description += `💥 Demos: ${updatedPlayer.demos || 0} | `;
                description += `🏆 MVPs: ${updatedPlayer.mvps}`;
                
                const embed = createEmbed('Stats Removed', description, config.colors.success);
                
                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Error removing stats:', error);
                
                await interaction.reply({ 
                    content: `Error removing stats: ${error.message}`,
                    ephemeral: true
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
                    ephemeral: true 
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
                    ephemeral: true
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
                    ephemeral: true 
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
                    ephemeral: true
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
                    ephemeral: true 
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
                    ephemeral: true
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
                    ephemeral: true 
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
                    ephemeral: true
                });
            }
            
            return;
        }

        // *** ADD THE WIPE COMMANDS HERE ***
        
        // Wipe player stats
        if (commandName === 'wipe-players') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    ephemeral: true 
                });
                return;
            }
            
            await db.writePlayersFile([]);
            
            const embed = createEmbed('Player Data Wiped', 
                '⚠️ All player stats have been reset to zero!', 
                config.colors.error);
            
            await interaction.reply({ embeds: [embed] });
            return;
        }

        // Wipe team records
        if (commandName === 'wipe-teams') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    ephemeral: true 
                });
                return;
            }
            
            const defaultTeamStats = {
                'A-Team': { wins: 0, losses: 0 },
                'B-Team': { wins: 0, losses: 0 }
            };
            await db.writeTeamStatsFile(defaultTeamStats);
            
            const embed = createEmbed('Team Records Wiped', 
                '⚠️ All team win/loss records have been reset!', 
                config.colors.error);
            
            await interaction.reply({ embeds: [embed] });
            return;
        }

        // Wipe import history
        if (commandName === 'wipe-imports') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    ephemeral: true 
                });
                return;
            }
            
            await db.writeImportedGamesFile([]);
            
            const embed = createEmbed('Import History Wiped', 
                '🔄 Import history cleared - you can now re-import any CSV files!', 
                config.colors.success);
            
            await interaction.reply({ embeds: [embed] });
            return;
        }

        // Wipe everything
        if (commandName === 'wipe-all') {
            if (!(await isAdmin(interaction.member))) {
                await interaction.reply({ 
                    content: `You need the "${config.adminRoleName}" role to use this command.`,
                    ephemeral: true 
                });
                return;
            }
            
            // Reset all data files
            await db.writePlayersFile([]);
            await db.writeNameMappingFile({});
            await db.writeImportedGamesFile([]);
            
            const defaultTeamStats = {
                'A-Team': { wins: 0, losses: 0 },
                'B-Team': { wins: 0, losses: 0 }
            };
            await db.writeTeamStatsFile(defaultTeamStats);
            
            const embed = createEmbed('ALL DATA WIPED', 
                '🔥 Complete reset: All players, teams, mappings, and import history cleared!', 
                config.colors.error);
            
            await interaction.reply({ embeds: [embed] });
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
                    ephemeral: true 
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