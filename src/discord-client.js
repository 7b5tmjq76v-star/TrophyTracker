import { Client, GatewayIntentBits, Partials } from 'discord.js';

export async function getDiscordClient() {
  const token = process.env.DISCORD_BOT_TOKEN;

  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN environment variable is not set');
  }

  console.log('Token exists, length:', token.length);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, 
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    // DM channels aren't cached, so they arrive as partials
    partials: [Partials.Channel]
  });

  try {
    await client.login(token);
    console.log('Login successful!');
  } catch (error) {
    console.error('Login failed:', error.message);
    throw error;
  }
  
  return client;
}
