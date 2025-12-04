require("dotenv").config();

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("ttrl-signup")
    .setDescription("TTRL next season sign up")
    .addRoleOption((option) =>
      option
        .setName("ft_role")
        .setDescription("Role for current Full Time drivers")
        .setRequired(true)
    )
    .addRoleOption((option) =>
      option
        .setName("reserve_role")
        .setDescription("Role for current Reserve drivers")
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName("stats_channel")
        .setDescription("Channel to post/update the signup summary")
        .setRequired(true)
    ),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering commands for specific guild (instant)...");

    // Register for specific guild (instant)
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commands }
    );

    console.log("Successfully registered guild commands.");

    console.log("Registering global commands (takes 1 hour)...");

    // Also register globally (takes time but works everywhere)
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );

    console.log("Successfully registered global commands.");
  } catch (error) {
    console.error(error);
  }
})();
