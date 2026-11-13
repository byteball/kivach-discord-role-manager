const { Client, GatewayIntentBits } = require('discord.js');

const discordInstance = new Client({ intents: [GatewayIntentBits.Guilds] });

module.exports = discordInstance;
