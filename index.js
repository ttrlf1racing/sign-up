// ====================================================================
//  TTRL SIGNUP BOT - FULL UPDATED VERSION (2026-01-14)
// ====================================================================

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  Events,
  PermissionsBitField,
} = require('discord.js');
const { google } = require('googleapis');

// ---------------------------------------------------------------------
// GOOGLE SHEETS SETUP
// ---------------------------------------------------------------------
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

const statsChannelByGuild = new Map();    // guild → stats channel
const autoRoleByChoice = new Map();       // choice → role ID

console.log("Google ENV:");
console.log("  GOOGLE_SPREADSHEET_ID:", SPREADSHEET_ID);
console.log("  GOOGLE_CLIENT_EMAIL:", process.env.GOOGLE_CLIENT_EMAIL);
console.log("  GOOGLE_PRIVATE_KEY length:", process.env.GOOGLE_PRIVATE_KEY?.length);

const googleAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

googleAuth.getClient().then(() => {
  console.log("Google Sheets auth OK");
}).catch(err => {
  console.error("Google Sheets auth FAILED", err);
});

async function getSheetsClient() {
  const authClient = await googleAuth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}


// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------

function formatTimestamp(date = new Date()) {
  const pad = n => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatMembership(joinedTimestamp) {
  const diffMs = Date.now() - joinedTimestamp;
  const days = Math.floor(diffMs / 86400000);
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);

  if (years === 0 && months === 0) return "<1m";
  if (years === 0) return `${months}m`;
  if (months === 0) return `${years} seasons`;
  return `${years} seasons ${months}m`;
}

async function hasAlreadySubmitted(name) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!B:B"
  });
  const rows = res.data.values || [];
  return rows.some(row => row[0] === name);
}


// ---------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------

async function getSignupSummaryFromSheets() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!E:M"
  });

  const rows = res.data.values || [];
  let start = rows[0]?.[0] === "Driver Type" ? 1 : 0;

  const summary = {
    total: 0,
    ft: { stay: 0, reserve: 0, leave: 0 },
    res: { wantsFt: 0, stay: 0, leave: 0 },
  };

  for (let i = start; i < rows.length; i++) {
    const [driverType, , , , , , , , choice] = rows[i];
    if (!driverType || !choice) continue;

    summary.total++;

    if (driverType === "FT") {
      if (choice === "Stay FT") summary.ft.stay++;
      if (choice === "Move to Reserve") summary.ft.reserve++;
      if (choice === "Leaving TTRL") summary.ft.leave++;
    }

    if (driverType === "Reserve") {
      if (choice === "Wants FT seat") summary.res.wantsFt++;
      if (choice === "Stay Reserve") summary.res.stay++;
      if (choice === "Leaving TTRL") summary.res.leave++;
    }
  }

  return summary;
}

function formatSignupSummaryText(summary) {
  return [
    "**TTRL Signup Summary**",
    "",
    `Total responses: ${summary.total}`,
    "",
    "**Full Time Drivers:**",
    `  Stay FT: ${summary.ft.stay}`,
    `  Move to Reserve: ${summary.ft.reserve}`,
    `  Leaving TTRL: ${summary.ft.leave}`,
    "",
    "**Reserve Drivers:**",
    `  Wants FT seat: ${summary.res.wantsFt}`,
    `  Stay Reserve: ${summary.res.stay}`,
    `  Leaving TTRL: ${summary.res.leave}`,
  ].join("\n");
}

async function updateSignupSummaryMessage(client, guildId) {
  const channelId = statsChannelByGuild.get(guildId);
  if (!channelId) return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const summary = await getSignupSummaryFromSheets();
  const text = formatSignupSummaryText(summary);

  async function findSummary() {
    let lastId = null;
    let fetched = 0;
    while (fetched < 500) {
      const opts = { limit: 100 };
      if (lastId) opts.before = lastId;

      const msgs = await channel.messages.fetch(opts);
      if (!msgs.size) break;

      fetched += msgs.size;

      const match = msgs.find(m =>
        m.author.id === client.user.id &&
        m.content.startsWith("**TTRL Signup Summary**")
      );
      if (match) return match;

      lastId = msgs.last().id;
    }
    return null;
  }

  const existing = await findSummary();

  if (existing) existing.edit(text);
  else channel.send(text);
}


// ---------------------------------------------------------------------
// LOG TO SHEET
// ---------------------------------------------------------------------

async function logToSheet(entry) {
  const sheets = await getSheetsClient();
  const values = [[
    entry.timestamp,
    entry.displayName,
    entry.username,
    entry.currentRole,
    entry.driverType,
    entry.membershipText,
    entry.userId,
    entry.accountCreated,
    entry.avatarUrl,
    entry.allRoles,
    entry.boostStatus,
    entry.joinDate,
    entry.choice
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:M",
    valueInputOption: "USER_ENTERED",
    requestBody: { values }
  });
}



// =====================================================================
// DISCORD CLIENT
// =====================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});
// =====================================================================
// INTERACTIONS
// =====================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {

    // =================================================================
    // SLASH COMMANDS
    // =================================================================
    if (interaction.isChatInputCommand()) {

      // ===============================================================
      // /ttrl-signup
      // ===============================================================
      if (interaction.commandName === "ttrl-signup") {

        // Permissions
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", ephemeral: true });
        }
        const perms = interaction.memberPermissions;
        const admin =
          perms?.has(PermissionsBitField.Flags.Administrator) ||
          perms?.has(PermissionsBitField.Flags.ManageGuild);
        if (!admin) {
          return interaction.reply({ content: "Admins only.", ephemeral: true });
        }

        // Try canonical names
        let statsChannel = interaction.options.getChannel("statschannel");

        // Fallback: detect automatically
        const hoisted = interaction.options._hoistedOptions ?? [];
        const chanOptions = hoisted.filter(o => o.channel).map(o => o.channel);

        if (!statsChannel && chanOptions[0]) statsChannel = chanOptions[0];

        if (!statsChannel) {
          return interaction.reply({
            content: "This command must include a **channel option** (stats).",
            ephemeral: true
          });
        }

        statsChannelByGuild.set(interaction.guildId, statsChannel.id);

        const channel = await client.channels.fetch(interaction.channelId);
        if (!channel?.isTextBased()) {
          return interaction.reply({
            content: "I cannot post here.",
            ephemeral: true
          });
        }

        const embed = new EmbedBuilder()
          .setTitle("TTRL Sign-Up Process")
          .setDescription([
            "Welcome to the TTRL sign-up process!",
            "",
            "Please choose your intention for the upcoming season:",
            "- Full Time Seat",
            "- Reserve Seat",
            "- Leaving TTRL",
            "",
            "Click one of the buttons below to record your choice."
          ].join("\n"))
          .setThumbnail("attachment://ttrl-logo.png")
          .setColor(0xffcc00);

        const file = new AttachmentBuilder("ttrl-logo.png");

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("ttrlchoice|Full Time Seat")
            .setLabel("Full Time Seat")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("ttrlchoice|Reserve Seat")
            .setLabel("Reserve Seat")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("ttrlchoice|Leaving TTRL")
            .setLabel("Leaving TTRL")
            .setStyle(ButtonStyle.Danger),
        );

        await channel.send({ embeds: [embed], components: [row], files: [file] });
        await interaction.reply({ content: "Signup panel posted.", ephemeral: true });
        await updateSignupSummaryMessage(client, interaction.guildId);

        return;
      }


      // ===============================================================
      // /ttrl-set-autorole (unchanged)
//      ===============================================================
      if (interaction.commandName === "ttrl-set-autorole") {
        if (!interaction.inGuild()) return;

        const perms = interaction.memberPermissions;
        const admin =
          perms?.has(PermissionsBitField.Flags.Administrator) ||
          perms?.has(PermissionsBitField.Flags.ManageGuild);
        if (!admin) {
          return interaction.reply({ content: "Admins only.", ephemeral: true });
        }

        let choice = interaction.options.getString("choice");
        let role = interaction.options.getRole("role");

        const hoisted = interaction.options._hoistedOptions ?? [];
        if (!choice) {
          const strOpt = hoisted.find(o => typeof o.value === "string" && !o.role);
          if (strOpt) choice = strOpt.value;
        }
        if (!role) {
          const rOpt = hoisted.find(o => o.role);
          if (rOpt) role = rOpt.role;
        }

        if (!choice) {
          return interaction.reply({
            content: "Missing choice string.",
            ephemeral: true
          });
        }

        if (!role) {
          autoRoleByChoice.delete(choice);
          return interaction.reply({
            content: `Auto-role disabled for **${choice}**.`,
            ephemeral: true
          });
        }

        autoRoleByChoice.set(choice, role.id);
        return interaction.reply({
          content: `Users selecting **${choice}** will now receive **${role.name}** automatically.`,
          ephemeral: true
        });
      }

      return;
    }



    // =================================================================
    // BUTTON HANDLING
    // =================================================================
    if (!interaction.isButton()) return;

    const [base, choiceLabel] = interaction.customId.split("|");
    if (base !== "ttrlchoice") return;

    const user = interaction.user;

    // Ensure full guild member object
    let member = interaction.member;
    if (!member) {
      member = await interaction.guild.members.fetch(user.id).catch(() => null);
    }
    if (!member) {
      return interaction.reply({ content: "Could not load your member data.", ephemeral: true });
    }

    const displayName = member.displayName || member.user.username;
    const membershipText = formatMembership(member.joinedTimestamp || Date.now());

    // Prevent duplicate submissions
    if (await hasAlreadySubmitted(displayName)) {
      return interaction.reply({
        content: "You have already submitted your signup.",
        ephemeral: true
      });
    }

    const currentRole = "Driver";
    const driverType = "Unknown";
    const choice = choiceLabel; // "Full Time Seat" | "Reserve Seat" | "Leaving TTRL"

    await logToSheet({
      displayName,
      username: user.username,
      currentRole,
      driverType,
      choice,
      timestamp: formatTimestamp(),
      membershipText,
      userId: member.id,
      accountCreated: member.user.createdAt.toISOString().split("T")[0],
      avatarUrl: member.user.displayAvatarURL({ size: 256 }),
      allRoles: member.roles.cache.map(r => r.name).filter(n => n !== "@everyone").join(", ") || "None",
      boostStatus: member.premiumSince ? `Since ${member.premiumSince.toISOString().split("T")[0]}` : "Not boosting",
      joinDate: member.joinedAt?.toISOString().split("T")[0] || "Unknown"
    });

    await updateSignupSummaryMessage(client, interaction.guildId);

    // Handle Leaving TTRL role changes
    if (choice === "Leaving TTRL") {
      const leavingRoleId = "1460986192966455449";

      // Remove all roles except @everyone (guild id)
      const rolesToRemove = member.roles.cache.filter(r => r.id !== interaction.guild.id);
      if (rolesToRemove.size > 0) {
        try {
          await member.roles.remove(rolesToRemove);
        } catch (err) {
          console.error("Failed to remove roles for Leaving TTRL:", err);
        }
      }

      // Add Leaving role
      const leavingRole = interaction.guild.roles.cache.get(leavingRoleId);
      if (leavingRole) {
        try {
          await member.roles.add(leavingRole);
        } catch (err) {
          console.error("Failed to add Leaving role:", err);
        }
      }
    }

    // Optional auto-role based on choice (if configured)
    if (autoRoleByChoice.has(choice)) {
      const roleId = autoRoleByChoice.get(choice);
      try { await member.roles.add(roleId); }
      catch (err) { console.error("Auto-role failed:", err.message); }
    }

    await interaction.reply({
      content: `Your signup choice **${choice}** has been recorded. A DM has been sent.`,
      ephemeral: true
    });

    member.send(`Your TTRL signup choice has been recorded as: ${choice}.`).catch(() => {});

  } catch (err) {
    console.error("Interaction error:", err);
    if (interaction.replied || interaction.deferred) {
      interaction.followUp({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
    } else {
      interaction.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
    }
  }
});


// =====================================================================
// LOGIN
// =====================================================================
client.login(process.env.DISCORD_TOKEN);
