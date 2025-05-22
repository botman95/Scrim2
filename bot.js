// Discord Stats Bot for tracking team statistics
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
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
    teamStatsFilePath: path.join(__dirname, 'team-stats.json')
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

    // Create a new player
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
    }
};

// Achievements definition
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

// Define slash commands - Updated to include new commands
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
        .addIntegerOption(option => {
            const intOption = option.setName('games')
                .setDescription('Number of games to add')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for games option');
            }
            
            return intOption;
        })
        .addIntegerOption(option => {
            const intOption = option.setName('goals')
                .setDescription('Number of goals to add')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for goals option');
            }
            
            return intOption;
        })
        .addIntegerOption(option => {
            const intOption = option.setName('assists')
                .setDescription('Number of assists to add')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for assists option');
            }
            
            return intOption;
        })
        .addIntegerOption(option => {
            const intOption = option.setName('saves')
                .setDescription('Number of saves to add')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for saves option');
            }
            
            return intOption;
        })
        .addIntegerOption(option => {
            const intOption = option.setName('mvps')
                .setDescription('Number of MVPs to add')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for mvps option');
            }
            
            return intOption;
        }),

    new SlashCommandBuilder()
        .setName('removestats')
        .setDescription('Remove stats for a player')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to remove stats from')
                .setRequired(true))
        .addIntegerOption(option => {
            const intOption = option.setName('games')
                .setDescription('Number of games to remove')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for games option');
            }
            
            return intOption;
        })
        .addIntegerOption(option => {
            const intOption = option.setName('goals')
                .setDescription('Number of goals to remove')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for goals option');
            }
            
            return intOption;
        })
        .addIntegerOption(option => {
            const intOption = option.setName('assists')
                .setDescription('Number of assists to remove')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for assists option');
            }
            
            return intOption;
        })
        .addIntegerOption(option => {
            const intOption = option.setName('saves')
                .setDescription('Number of saves to remove')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for saves option');
            }
            
            return intOption;
        })
        .addIntegerOption(option => {
            const intOption = option.setName('mvps')
                .setDescription('Number of MVPs to remove')
                .setRequired(false);
            
            try {
                intOption.setMinValue(0);
            } catch (err) {
                console.warn('Could not set min value for mvps option');
            }
            
            return intOption;
        }),

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
        .addIntegerOption(option => {
            const intOption = option.setName('wins')
                .setDescription('Number of wins to add (default: 1)')
                .setRequired(false);
            
            try {
                intOption.setMinValue(1);
            } catch (err) {
                console.warn('Could not set min value for wins option');
            }
            
            return intOption;
        }),

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
        .addIntegerOption(option => {
            const intOption = option.setName('losses')
                .setDescription('Number of losses to add (default: 1)')
                .setRequired(false);
            
            try {
                intOption.setMinValue(1);
            } catch (err) {
                console.warn('Could not set min value for losses option');
            }
            
            return intOption;
        }),

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
        .addIntegerOption(option => {
            const intOption = option.setName('wins')
                .setDescription('Number of wins to remove (default: 1)')
                .setRequired(false);
            
            try {
                intOption.setMinValue(1);
            } catch (err) {
                console.warn('Could not set min value for wins option');
            }
            
            return intOption;
        }),

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
        .addIntegerOption(option => {
            const intOption = option.setName('losses')
                .setDescription('Number of losses to remove (default: 1)')
                .setRequired(false);
            
            try {
                intOption.setMinValue(1);
            } catch (err) {
                console.warn('Could not set min value for losses option');
            }
            
            return intOption;
        })
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

// Create player stats embed
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
            { name: '🏆 MVPs', value: player.mvps.toString(), inline: true },
            { name: '👑 Achievements', value: calculateAchievements(player) }
        )
        .setFooter({ text: 'Stats Bot', iconURL: 'https://i.imgur.com/wSTFkRM.png' })
        .setTimestamp();
}

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

// Interaction handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    try {
        const commandName = interaction.commandName;
        
        // Help command
        if (commandName === 'help') {
            const embed = createEmbed('Stats Bot Help', 'List of available commands:');
            
            embed.addFields(
                { name: '/help', value: 'Shows this help message', inline: false },
                { name: '/stats [user]', value: 'Shows stats for a user (or yourself if no user is specified)', inline: false },
                { name: '/team <team>', value: 'Shows player leaderboard for a specific team', inline: false },
                { name: '/team-stats <team>', value: 'Shows win/loss record for a specific team', inline: false },
                { name: '/leaderboard', value: 'Shows the overall leaderboard across both teams', inline: false },
                { name: '/achievements', value: 'Shows all available achievements and how to unlock them', inline: false },
                { name: '**Admin Commands**', value: 'The following commands require the Scrimster role:', inline: false },
                { name: '/register <user> <team>', value: 'Register a new player to a team', inline: false },
                { name: '/addstats <user> [goals] [assists] [saves] [games] [mvps]', value: 'Add stats for a player', inline: false },
                { name: '/removestats <user> [goals] [assists] [saves] [games] [mvps]', value: 'Remove stats from a player', inline: false },
                { name: '/team-win <team> [wins]', value: 'Add win(s) to a team record', inline: false },
                { name: '/team-loss <team> [losses]', value: 'Add loss(es) to a team record', inline: false },
                { name: '/team-remove-win <team> [wins]', value: 'Remove win(s) from a team record', inline: false },
                { name: '/team-remove-loss <team> [losses]', value: 'Remove loss(es) from a team record', inline: false }
            );
            
            await interaction.reply({ embeds: [embed] });
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
            
            // Get stats from options
            const stats = {
                gamesPlayed: interaction.options.getInteger('games') || 0,
                goals: interaction.options.getInteger('goals') || 0,
                assists: interaction.options.getInteger('assists') || 0,
                saves: interaction.options.getInteger('saves') || 0,
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
                
                // Build description of what was added
                let description = `Stats added for **${updatedPlayer.displayName}**:\n\n`;
                if (stats.gamesPlayed > 0) description += `🎮 **Games**: +${stats.gamesPlayed}\n`;
                if (stats.goals > 0) description += `⚽ **Goals**: +${stats.goals}\n`;
                if (stats.assists > 0) description += `👟 **Assists**: +${stats.assists}\n`;
                if (stats.saves > 0) description += `🧤 **Saves**: +${stats.saves}\n`;
                if (stats.mvps > 0) description += `🏆 **MVPs**: +${stats.mvps}\n`;
                
                description += `\n**New Totals**:\n`;
                description += `🎮 Games: ${updatedPlayer.gamesPlayed} | `;
                description += `⚽ Goals: ${updatedPlayer.goals} | `;
                description += `👟 Assists: ${updatedPlayer.assists} | `;
                description += `🧤 Saves: ${updatedPlayer.saves} | `;
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
            
            // Get stats from options
            const stats = {
                gamesPlayed: interaction.options.getInteger('games') || 0,
                goals: interaction.options.getInteger('goals') || 0,
                assists: interaction.options.getInteger('assists') || 0,
                saves: interaction.options.getInteger('saves') || 0,
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
                
                // Build description of what was removed
                let description = `Stats removed from **${updatedPlayer.displayName}**:\n\n`;
                if (stats.gamesPlayed > 0) description += `🎮 **Games**: -${stats.gamesPlayed}\n`;
                if (stats.goals > 0) description += `⚽ **Goals**: -${stats.goals}\n`;
                if (stats.assists > 0) description += `👟 **Assists**: -${stats.assists}\n`;
                if (stats.saves > 0) description += `🧤 **Saves**: -${stats.saves}\n`;
                if (stats.mvps > 0) description += `🏆 **MVPs**: -${stats.mvps}\n`;
                
                description += `\n**New Totals**:\n`;
                description += `🎮 Games: ${updatedPlayer.gamesPlayed} | `;
                description += `⚽ Goals: ${updatedPlayer.goals} | `;
                description += `👟 Assists: ${updatedPlayer.assists} | `;
                description += `🧤 Saves: ${updatedPlayer.saves} | `;
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