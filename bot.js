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
    dataFilePath: path.join(__dirname, 'players.json')
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

// Define slash commands - Updated to remove direct .setMinValue calls
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
        .setDescription('Shows stats for a team')
        .addStringOption(option => 
            option.setName('team')
                .setDescription('The team to check stats for')
                .setRequired(true)
                .addChoices(
                    { name: 'A-Team', value: 'A-Team' },
                    { name: 'B-Team', value: 'B-Team' }
                )),

    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Shows the overall leaderboard'),
    
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
                // This separates the min value validation to avoid potential validation issues
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

// Interaction handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    try {
        const commandName = interaction.commandName;
        
        // Help command
        if (commandName === 'help') {
            // Defer reply to give more time for processing
            await interaction.deferReply();
            
            const embed = createEmbed('Stats Bot Help', 'List of available commands:');
            
            embed.addFields(
                { name: '/help', value: 'Shows this help message', inline: false },
                { name: '/stats [user]', value: 'Shows stats for a user (or yourself if no user is specified)', inline: false },
                { name: '/team <team>', value: 'Shows stats for a specific team (A-Team or B-Team)', inline: false },
                { name: '/leaderboard', value: 'Shows the overall leaderboard across both teams', inline: false },
                { name: '**Admin Commands**', value: 'The following commands require the Scrimster role:', inline: false },
                { name: '/register <user> <team>', value: 'Register a new player to a team', inline: false },
                { name: '/addstats <user> [goals] [assists] [saves] [games] [mvps]', value: 'Add stats for a player', inline: false },
                { name: '/removestats <user> [goals] [assists] [saves] [games] [mvps]', value: 'Remove stats from a player', inline: false }
            );
            
            await safeReply(interaction, { embeds: [embed] });
            return;
        }
        
        // Stats command
        if (commandName === 'stats') {
            // Defer reply to give more time for processing
            await interaction.deferReply();
            
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const userId = targetUser.id;
            
            // Get the player from database
            let player = await db.getPlayer(userId);
            
            if (!player) {
                await safeReply(interaction, { 
                    content: `${targetUser.username} is not registered yet. An admin can register them with the \`/register\` command.` 
                });
                return;
            }
            
            // Create the stats embed
            const embed = playerStatsEmbed(player);
            
            // Add user avatar if available
            if (targetUser.avatar) {
                embed.setThumbnail(targetUser.displayAvatarURL());
            }
            
            await safeReply(interaction, { embeds: [embed] });
            return;
        }
        
        // Team command
        if (commandName === 'team') {
            // Defer reply to give more time for processing
            await interaction.deferReply();
            
            const teamName = interaction.options.getString('team');
            
            // Get all players for the team
            const players = await db.getAllPlayers(teamName);
            
            if (players.length === 0) {
                await safeReply(interaction, { 
                    content: `No players found for ${teamName}. Use \`/register\` to add players to this team.` 
                });
                return;
            }
            
            // Create the team stats embed
            const embed = teamLeaderboardEmbed(players, teamName);
            
            await safeReply(interaction, { embeds: [embed] });
            return;
        }
        
        // Leaderboard command
        if (commandName === 'leaderboard') {
            // Defer reply to give more time for processing
            await interaction.deferReply();
            
            // Get all players from both teams
            const players = await db.getAllPlayers();
            
            if (players.length === 0) {
                await safeReply(interaction, { 
                    content: `No players registered yet. Use \`/register\` to add players.` 
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
            
            await safeReply(interaction, { embeds: [embed] });
            return;
        }
        
        // Register command (Admin only)
        if (commandName === 'register') {
            // Defer reply to give more time for processing
            await interaction.deferReply();
            
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await safeReply(interaction, { 
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
                    
                    await safeReply(interaction, { 
                        content: `${targetUser.username} has been moved to ${team}.`,
                        ephemeral: false
                    });
                } else {
                    await safeReply(interaction, { 
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
                
                await safeReply(interaction, { embeds: [embed] });
            } catch (error) {
                console.error('Error registering player:', error);
                
                await safeReply(interaction, { 
                    content: `Error registering player: ${error.message}`,
                    ephemeral: true
                });
            }
            
            return;
        }
        
        // Add stats command (Admin only)
        if (commandName === 'addstats') {
            // Defer reply to give more time for processing
            await interaction.deferReply();
            
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await safeReply(interaction, { 
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
                await safeReply(interaction, { 
                    content: 'Please provide at least one stat to add.',
                    ephemeral: true
                });
                return;
            }
            
            // Check if player exists
            let player = await db.getPlayer(targetUser.id);
            
            if (!player) {
                await safeReply(interaction, { 
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
                if (stats.saves > 0) description += `🧤 **Saves**: +${stats.saves}\n`;if (stats.mvps > 0) description += `🏆 **MVPs**: +${stats.mvps}\n`;
                
                description += `\n**New Totals**:\n`;
                description += `🎮 Games: ${updatedPlayer.gamesPlayed} | `;
                description += `⚽ Goals: ${updatedPlayer.goals} | `;
                description += `👟 Assists: ${updatedPlayer.assists} | `;
                description += `🧤 Saves: ${updatedPlayer.saves} | `;
                description += `🏆 MVPs: ${updatedPlayer.mvps}`;
                
                const embed = createEmbed('Stats Added', description, config.colors.success);
                
                await safeReply(interaction, { embeds: [embed] });
            } catch (error) {
                console.error('Error adding stats:', error);
                
                await safeReply(interaction, { 
                    content: `Error adding stats: ${error.message}`,
                    ephemeral: true
                });
            }
            
            return;
        }
        
        // Remove stats command (Admin only)
        if (commandName === 'removestats') {
            // Defer reply to give more time for processing
            await interaction.deferReply();
            
            // Check if user has admin role
            if (!(await isAdmin(interaction.member))) {
                await safeReply(interaction, { 
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
                await safeReply(interaction, { 
                    content: 'Please provide at least one stat to remove.',
                    ephemeral: true
                });
                return;
            }
            
            // Check if player exists
            let player = await db.getPlayer(targetUser.id);
            
            if (!player) {
                await safeReply(interaction, { 
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
                
                await safeReply(interaction, { embeds: [embed] });
            } catch (error) {
                console.error('Error removing stats:', error);
                
                await safeReply(interaction, { 
                    content: `Error removing stats: ${error.message}`,
                    ephemeral: true
                });
            }
            
            return;
        }
        
    } catch (error) {
        // Global error handler for all command processing
        console.error(`Error processing command ${interaction.commandName}:`, error);
        
        try {
            // Try to inform the user that something went wrong
            const errorMessage = error.code === 10062 
                ? "The response took too long to process. Please try again."
                : "An error occurred while processing your command. Please try again.";
                
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: errorMessage,
                    ephemeral: true
                });
            } else if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
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