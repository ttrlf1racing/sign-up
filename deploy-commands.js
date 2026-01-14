require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('ttrl-signup')
    .setDescription('TTRL next season sign up')
    .addChannelOption(option =>
      option.setName('statschannel')
        .setDescription('Channel to post & update the signup summary')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('ttrl-set-autorole')
    .setDescription('Set automatic role assignment for signup choices (optional)')
    .addStringOption(option =>
      option.setName('choice')
        .setDescription('Which signup choice')
        .setRequired(true)
        .addChoices(
          { name: 'Full Time Seat', value: 'Full Time Seat' },
          { name: 'Reserve Seat', value: 'Reserve Seat' },
          { name: 'Leaving TTRL', value: 'Leaving TTRL' },
        ))
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('Role to assign (leave empty to disable auto-role for this choice)')
        .setRequired(false))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering commands...');
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commands }
    );
    console.log('Successfully registered application commands.');
  } catch (error) {
    console.error(error);
  }
})();
