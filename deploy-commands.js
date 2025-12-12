require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('ttrl-signup')
    .setDescription('TTRL next season sign up')
    .addRoleOption(option =>
      option.setName('ftrole')
        .setDescription('Role for current Full Time drivers')
        .setRequired(true))
    .addRoleOption(option =>
      option.setName('reserverole')
        .setDescription('Role for current Reserve drivers')
        .setRequired(true))
    .addChannelOption(option =>
      option.setName('statschannel')
        .setDescription('Channel to post & update the signup summary')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('ttrl-set-autorole')
    .setDescription('Set automatic role assignment for signup choices (optional)')
    .addStringOption(option =>
      option.setName('choice')
        .setDescription('Which signup choice')
        .setRequired(true)
        .addChoices(
          { name: 'FT → Stay FT', value: 'Stay FT' },
          { name: 'FT → Move to Reserve', value: 'Move to Reserve' },
          { name: 'FT → Leaving TTRL', value: 'Leaving TTRL' },
          { name: 'Reserve → Wants FT seat', value: 'Wants FT seat' },
          { name: 'Reserve → Stay Reserve', value: 'Stay Reserve' },
          { name: 'Reserve → Leaving TTRL', value: 'Leaving TTRL' }
        ))
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('Role to assign (leave empty to disable auto-role for this choice)')
        .setRequired(false)),

  // NEW: /ttrl-timetrial
  new SlashCommandBuilder()
    .setName('ttrl-timetrial')
    .setDescription('Submit Time Trial lap times for Bahrain, Austria and Silverstone')
    .addStringOption(option =>
      option.setName('bahrain')
        .setDescription('Bahrain lap time (mm:ss.mmm)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('austria')
        .setDescription('Austria lap time (mm:ss.mmm)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('silverstone')
        .setDescription('Silverstone lap time (mm:ss.mmm)')
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
