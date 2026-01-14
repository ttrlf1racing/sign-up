// ====================================================================
//  TTRL SIGNUP BOT - UPDATED FOR NEW SHEET LAYOUT
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

// Membership text, using “Years”.
function formatMembership(joinedTimestamp) {
  const diffMs = Date.now() - joinedTimestamp;
  const days = Math.floor(diffMs / 86400000);
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);

  if (years === 0 && months === 0) return "<1m";
  if (years === 0) return `${months}m`;
  if (months === 0) return `${years} Years`;
  return `${years} Years ${months}m`;
}

// Check by Display Name if already logged
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
// SUMMARY (kept compatible with your existing E:M legacy block if needed)
// ---------------------------------------------------------------------

async function getSignupSummaryFromSheets() {
  const sheets = await getSheetsClient();
  // If you change how summary works later, adjust this range/logic.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!E:M"
  });

  const rows = res.data.values || [];
  const summary = {
    total: 0,
    fullTimeSeat: 0,
    reserveSeat: 0,
    leaving: 0,
  };

  // E is Choice in the new layout
  for (let i = 1; i < rows.length; i++) {
    const [choice] = rows[i];
    if (!choice) continue;
    summary.total++;

    if (choice === "Full Time Seat") summary.fullTimeSeat++;
    else if (choice === "Reserve Seat") summary.reserveSeat++;
    else if (choice === "Leaving TTRL") summary.leaving++;
  }

  return summary;
}

function formatSignupSummaryText(summary) {
  return [
    "**TTRL Signup Summary**",
    "",
    `Total responses: ${summary.total}`,
    "",
    `Full Time Seat: ${summary.fullTimeSeat}`,
    `Reserve Seat: ${summary.reserveSeat}`,
    `Leaving TTRL: ${summary.leaving}`,
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
// LOG TO SHEET – new layout A:L
// ---------------------------------------------------------------------

async function logToSheet(entry) {
  const sheets = await getSheetsClient();
  const values = [[
    entry.timestamp,        // A
    entry.displayName,      // B
    entry.username,         // C
    entry.currentRole,      // D (top role)
    entry.choice,           // E
    entry.membershipText,   // F
    entry.joinDate,         // G
    entry.userId,           // H
    entry.accountCreated,   // I
    entry.avatarUrl,        // J
    entry.allRoles,         // K
    entry.boostStatus       // L
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:L",
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

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: 64 });
        }
        const perms = interaction.memberPermissions;
        const admin =
          perms?.has(PermissionsBitField.Flags.Administrator) ||
          perms?.has(PermissionsBitField.Flags.ManageGuild);
        if (!admin) {
          return interaction.reply({ content: "Admins only.", flags: 64 });
        }

        let statsChannel = interaction.options.getChannel("statschannel");

        const hoisted = interaction.options._hoistedOptions ?? [];
        const chanOptions = hoisted.filter(o => o.channel).map(o => o.channel);
        if (!statsChannel && chanOptions[0]) statsChannel = chanOptions[0];

        if (!statsChannel) {
          return interaction.reply({
            content: "This command must include a **channel option** (stats).",
            flags: 64
          });
        }

        statsChannelByGuild.set(interaction.guildId, statsChannel.id);

        const channel = await client.channels.fetch(interaction.channelId);
        if (!channel?.isTextBased()) {
          return interaction.reply({
            content: "I cannot post here.",
            flags: 64
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
        await interaction.reply({ content: "Signup panel posted.", flags: 64 });
        await updateSignupSummaryMessage(client, interaction.guildId);

        return;
      }

      // ===============================================================
      // /ttrl-set-autorole
      // ===============================================================
      if (interaction.commandName === "ttrl-set-autorole") {
        if (!interaction.inGuild()) return;

        const perms = interaction.memberPermissions;
        const admin =
          perms?.has(PermissionsBitField.Flags.Administrator) ||
          perms?.has(PermissionsBitField.Flags.ManageGuild);
        if (!admin) {
          return interaction.reply({ content: "Admins only.", flags: 64 });
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
            flags: 64
          });
        }

        if (!role) {
          autoRoleByChoice.delete(choice);
          return interaction.reply({
            content: `Auto-role disabled for **${choice}**.`,
            flags: 64
          });
        }

        autoRoleByChoice.set(choice, role.id);
        return interaction.reply({
          content: `Users selecting **${choice}** will now receive **${role.name}** automatically.`,
          flags: 64
        });
      }

      return;
    }
    // =================================================================
    // BUTTON HANDLING
    // =================================================================
    if (!interaction.isButton()) return;

    const [base, choiceLabel, state] = interaction.customId.split("|");
    if (base !== "ttrlchoice") return;

    // -----------------------------------------------------------------
    // 1) First click – Leaving TTRL: show confirmation
    // -----------------------------------------------------------------
    if (choiceLabel === "Leaving TTRL" && state !== "confirm") {
      await interaction.reply({
        content: "Are you sure you want to leave our great league?\n\nPlease note after clicking this button you will lose your current roles and be moved to the leaving channel.",
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("ttrlchoice|Leaving TTRL|confirm")
              .setLabel("Yes, I want to leave")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId("ttrlchoice|Leaving TTRL|cancel")
              .setLabel("Cancel")
              .setStyle(ButtonStyle.Secondary),
          )
        ],
        flags: 64 // ephemeral confirm
      });
      return;
    }

    // -----------------------------------------------------------------
    // 2) Handle Leaving TTRL cancel
    // -----------------------------------------------------------------
    if (choiceLabel === "Leaving TTRL" && state === "cancel") {
      await interaction.reply({
        content: "Leaving cancelled. Your roles will not be changed.",
        flags: 64
      });
      return;
    }

    // -----------------------------------------------------------------
    // 3) All confirmed choices (including confirmed Leaving)
    // -----------------------------------------------------------------
    await interaction.deferReply({ flags: 64 });

    const user = interaction.user;

    // Ensure full guild member object
    let member = interaction.member;
    if (!member) {
      member = await interaction.guild.members.fetch(user.id).catch(() => null);
    }
    if (!member) {
      return interaction.editReply({ content: "Could not load your member data." });
    }

    const displayName = member.displayName || member.user.username;
    const membershipText = formatMembership(member.joinedTimestamp || Date.now());

    // Prevent duplicate submissions (by display name)
    if (await hasAlreadySubmitted(displayName)) {
      return interaction.editReply({
        content: "You have already submitted your signup."
      });
    }

    // Highest role (excluding @everyone)
    const topRole = member.roles.highest && member.roles.highest.id !== interaction.guild.id
      ? member.roles.highest.name
      : "None";

    const currentRole = topRole;

    // Choice: either Full Time Seat / Reserve Seat / Leaving TTRL
    const choice = choiceLabel;

    await logToSheet({
      displayName,
      username: user.username,
      currentRole,
      choice,
      timestamp: formatTimestamp(),
      membershipText,
      joinDate: member.joinedAt?.toISOString().split("T")[0] || "Unknown",
      userId: member.id,
      accountCreated: member.user.createdAt.toISOString().split("T")[0],
      avatarUrl: member.user.displayAvatarURL({ size: 256 }),
      allRoles: member.roles.cache.map(r => r.name).filter(n => n !== "@everyone").join(", ") || "None",
      boostStatus: member.premiumSince ? `Since ${member.premiumSince.toISOString().split("T")[0]}` : "Not boosting"
    });

    await updateSignupSummaryMessage(client, interaction.guildId);

    // -----------------------------------------------------------------
    // 4) Apply Leaving roles (confirmed only)
    // -----------------------------------------------------------------
    if (choice === "Leaving TTRL") {
      const leavingRoleId = "1460986192966455449";
      const leavingRole = interaction.guild.roles.cache.get(leavingRoleId);

      if (leavingRole) {
        try {
          // Keep only @everyone and the Leaving role
          await member.roles.set([interaction.guild.id, leavingRoleId]);
        } catch (err) {
          console.error("Failed to set roles for Leaving TTRL:", err);
        }
      } else {
        console.error("Leaving role not found in guild:", leavingRoleId);
      }
    }

    // -----------------------------------------------------------------
    // 5) Optional auto-role based on choice (for non-leaving choices)
    // -----------------------------------------------------------------
    if (choice !== "Leaving TTRL" && autoRoleByChoice.has(choice)) {
      const roleId = autoRoleByChoice.get(choice);
      try { await member.roles.add(roleId); }
      catch (err) { console.error("Auto-role failed:", err.message); }
    }

    await interaction.editReply({
      content: `Your signup choice **${choice}** has been recorded. A DM has been sent.`
    });

    member.send(`Your TTRL signup choice has been recorded as: ${choice}.`).catch(() => {});


// =====================================================================
// LOGIN
// =====================================================================
client.login(process.env.DISCORD_TOKEN);
