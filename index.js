https://discord.com/oauth2/authorize?client_id=1443268453770330133&permissions=2416035840&integration_type=0&scope=bot+applications.commands   require("dotenv").config();

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
} = require("discord.js");
const { google } = require("googleapis");

// ---------------------------------------------------------------------
// GOOGLE SHEETS SETUP
// ---------------------------------------------------------------------

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

// Map: guildId -> stats channel id (set via /ttrl-signup)
const statsChannelByGuild = new Map();

console.log("GOOGLE ENV:");
console.log("  GOOGLE_SPREADSHEET_ID:", SPREADSHEET_ID);
console.log("  GOOGLE_CLIENT_EMAIL:", process.env.GOOGLE_CLIENT_EMAIL);
console.log(
  "  GOOGLE_PRIVATE_KEY length:",
  process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.length
    : "MISSING"
);

const googleAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY
      ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
      : undefined,
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

googleAuth
  .getClient()
  .then(() => console.log("Google Sheets auth OK (startup)"))
  .catch((err) => {
    console.error("Google Sheets auth FAILED at startup:");
    console.error(err);
  });

async function getSheetsClient() {
  const authClient = await googleAuth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

// Nicely formatted timestamp (YYYY-MM-DD HH:MM:SS)
function formatTimestamp(date = new Date()) {
  const pad = (n) => n.toString().padStart(2, "0");
  return (
    `${date.getFullYear()}-` +
    `${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())} ` +
    `${pad(date.getHours())}:` +
    `${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}`
  );
}

// Convert membership duration to years & months string
function formatMembership(joinedTimestamp) {
  const now = Date.now();
  const membershipMs = now - (joinedTimestamp || now);
  const membershipDays = Math.max(
    0,
    Math.floor(membershipMs / (1000 * 60 * 60 * 24))
  );

  const years = Math.floor(membershipDays / 365);
  const remainingDays = membershipDays % 365;
  const months = Math.floor(remainingDays / 30);

  if (years === 0 && months === 0) return "<1m";
  if (years === 0) return `${months}m`;
  if (months === 0) return `${years} Years`;
  return `${years} Years ${months}m`;
}

// Check if a server display name has already submitted
async function hasAlreadySubmitted(displayName) {
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!B:B", // column B = server display name
  });

  const rows = res.data.values || [];
  return rows.some((row) => row[0] === displayName);
}

// Read all answers from the sheet and build a summary object
async function getSignupSummaryFromSheets() {
  const sheets = await getSheetsClient();

  // Columns E (Driver Type) and F (Answer)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!E:E,M:M",
  });

  const rows = res.data.values || [];

  let startIndex = 0;
  if (rows.length && rows[0][0] === "Driver Type") {
    startIndex = 1;
  }

  const summary = {
    total: 0,
    ft: { stay: 0, reserve: 0, leave: 0 },
    res: { wantsFt: 0, stay: 0, leave: 0 },
  };

  for (let i = startIndex; i < rows.length; i++) {
    const [driverType, answer] = rows[i];
    if (!driverType || !answer) continue;

    summary.total++;

    if (driverType === "FT") {
      if (answer === "Stay FT") summary.ft.stay++;
      else if (answer === "Move to Reserve") summary.ft.reserve++;
      else if (answer === "Leaving TTRL") summary.ft.leave++;
    } else if (driverType === "Reserve") {
      if (answer === "Wants FT seat") summary.res.wantsFt++;
      else if (answer === "Stay Reserve") summary.res.stay++;
      else if (answer === "Leaving TTRL") summary.res.leave++;
    }
  }

  return summary;
}

// Turn the summary object into a nice text block
function formatSignupSummaryText(summary) {
  return [
    "**TTRL Signup Summary**",
    "",
    `Total responses: **${summary.total}**`,
    "",
    `**Full Time Drivers**`,
    `• Stay FT: **${summary.ft.stay}**`,
    `• Move to Reserve: **${summary.ft.reserve}**`,
    `• Leaving TTRL: **${summary.ft.leave}**`,
    "",
    `**Reserve Drivers**`,
    `• Wants FT seat: **${summary.res.wantsFt}**`,
    `• Stay Reserve: **${summary.res.stay}**`,
    `• Leaving TTRL: **${summary.res.leave}**`,
  ].join("\n");
}

// Update (or create) the summary message in the guild's stats channel
async function updateSignupSummaryMessage(client, guildId) {
  const channelId = statsChannelByGuild.get(guildId);
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const summary = await getSignupSummaryFromSheets();
  const text = formatSignupSummaryText(summary);

  const messages = await channel.messages.fetch({ limit: 20 });
  const existing = messages.find(
    (m) =>
      m.author.id === client.user.id &&
      m.content.startsWith("**TTRL Signup Summary**")
  );

  if (existing) {
    await existing.edit(text);
  } else {
    await channel.send(text);
  }
}

// Log one answer into the sheet
async function logToSheet(entry) {
  console.log("logToSheet called with:", entry);

  const sheets = await getSheetsClient();

// REPLACE lines 209-217 with:
const values = [[
  entry.timestamp,       // A
  entry.displayName,     // B
  entry.username,        // C
  entry.currentRole,     // D
  entry.driverType,      // E
  entry.membershipText,  // F
  entry.joinDate,        // G
  entry.userId,          // H
  entry.accountCreated,  // I
  entry.avatarUrl,       // J
  entry.allRoles,        // K
  entry.boostStatus,     // L
  entry.choice,          // M
]];


  try {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A:M",
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
    console.log("Sheets append result:", res.status, res.statusText);
  } catch (err) {
    console.error("Sheets append threw error:");
    console.error(err);
    throw err;
  }
}

// ---------------------------------------------------------------------
// DISCORD CLIENT
// ---------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

// ---------------------------------------------------------------------
// INTERACTION HANDLER
// ---------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  // Slash command: /ttrl-signup
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== "ttrl-signup") return;

    if (!interaction.inGuild()) {
      return interaction.reply({
        content: "Use this command in a server channel.",
        ephemeral: true,
      });
    }

    const perms = interaction.memberPermissions;
    const isAdminLike =
      perms &&
      (perms.has(PermissionsBitField.Flags.Administrator) ||
        perms.has(PermissionsBitField.Flags.ManageGuild));

    if (!isAdminLike) {
      return interaction.reply({
        content: "Only admins can post the TTRL signup panel.",
        ephemeral: true,
      });
    }

    const ftRole = interaction.options.getRole("ft_role", true);
    const reserveRole = interaction.options.getRole("reserve_role", true);
    const statsChannel = interaction.options.getChannel(
      "stats_channel",
      true
    );

    if (!statsChannel.isTextBased()) {
      return interaction.reply({
        content: "The stats channel must be a normal text channel.",
        ephemeral: true,
      });
    }

    // Remember which channel to use for summary for this guild
    statsChannelByGuild.set(interaction.guildId, statsChannel.id);

    let channel = null;
    try {
      channel = await client.channels.fetch(interaction.channelId);
    } catch {
      channel = null;
    }

    if (!channel || !channel.isTextBased()) {
      return interaction.reply({
        content:
          "I couldn't post in that channel. Please use a normal text channel I can send messages in.",
        ephemeral: true,
      });
    }

    // Panel content with logo embed
    const file = new AttachmentBuilder("ttrl-logo.png");
    const embed = new EmbedBuilder()
      .setTitle("📋 TTRL Sign-Up Process")
      .setDescription(
        "Welcome to the TTRL sign-up process!\n\n" +
          "As we approach our new season, we need to confirm each driver's intentions for the upcoming season.\n\n" +
          "Please select an option below and follow the prompts.\n\n" +
          "Thank you."
      )
      .setColor(0xffcc00)
      .setThumbnail("attachment://ttrl-logo.png");

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ttrl_open_ft:${ftRole.id}:${reserveRole.id}`)
        .setLabel("Current Full Time Driver")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`ttrl_open_res:${ftRole.id}:${reserveRole.id}`)
        .setLabel("Current Reserve")
        .setStyle(ButtonStyle.Secondary)
    );

    try {
      await channel.send({
        embeds: [embed],
        components: [row],
        files: [file],
      });

      await interaction.reply({
        content:
          "Signup panel posted in this channel and stats channel saved.",
        ephemeral: true,
      });

      // Initial summary build
      await updateSignupSummaryMessage(client, interaction.guildId);
    } catch (err) {
      console.error("Error sending panel message:", err);
      await interaction.reply({
        content:
          "I couldn't post in this channel. Please check my permissions and try again.",
        ephemeral: true,
      });
    }

    return;
  }

  // -------------------------------------------------------------------
  // BUTTONS
  // -------------------------------------------------------------------

  if (!interaction.isButton()) return;

  const [baseId, ftRoleId, reserveRoleId] = interaction.customId.split(":");
  const user = interaction.user;

  // Ensure we have a full GuildMember
  let member = interaction.member;
  if (!member && interaction.guild) {
    try {
      member = await interaction.guild.members.fetch(user.id);
    } catch {
      member = null;
    }
  }

  if (!member) {
    return interaction.reply({
      content:
        "I couldn't load your server info. Please try again or contact an admin.",
      ephemeral: true,
    });
  }

  const guildId = interaction.guildId;

  // Server display name (nickname or username)
  const displayName = member.displayName || user.username;

  // How long in server (seasons & months)
  const joinedTs = member.joinedTimestamp || Date.now();
  const membershipText = formatMembership(joinedTs);

  // Discord join date in YYYY-MM-DD format
  const joinDate = member.joinedAt 
    ? member.joinedAt.toISOString().split('T')[0] 
    : 'Unknown';

// ADD these new lines:
const userId = user.id;
const accountCreated = user.createdAt.toISOString().split('T')[0];
const avatarUrl = user.displayAvatarURL();
const allRoles = member.roles.cache
  .map(r => r.name)
  .filter(n => n !== '@everyone')
  .join(', ');
const boostStatus = member.premiumSince ? 'Yes' : 'No';  

  // Step 1: panel buttons (Current FT / Current Reserve)
  if (baseId === "ttrl_open_ft" || baseId === "ttrl_open_res") {
    const isFT = member.roles.cache.has(ftRoleId);
    const isReserve = member.roles.cache.has(reserveRoleId);

    if (baseId === "ttrl_open_ft" && !isFT) {
      return interaction.reply({
        content:
          "You clicked **Current Full Time Driver**, but you don't have the FT driver role.",
        ephemeral: true,
      });
    }

    if (baseId === "ttrl_open_res" && !isReserve) {
      return interaction.reply({
        content:
          "You clicked **Current Reserve**, but you don't have the Reserve driver role.",
        ephemeral: true,
      });
    }

    let content;
    let row;

    if (baseId === "ttrl_open_ft") {
      content =
        "For **current Drivers with a Full Time seat**:\n" +
        "Do you wish a FT seat for next season?";

      row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ttrl_ft_yes:${ftRoleId}:${reserveRoleId}`)
          .setLabel("Yes – keep FT seat")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`ttrl_ft_reserve:${ftRoleId}:${reserveRoleId}`)
          .setLabel("Move to Reserve")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`ttrl_ft_leave:${ftRoleId}:${reserveRoleId}`)
          .setLabel("Leaving TTRL")
          .setStyle(ButtonStyle.Danger)
      );
    } else {
      content =
        "For **Reserve Drivers**:\n" +
        "What are you looking for next season?";
      row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ttrl_res_ft:${ftRoleId}:${reserveRoleId}`)
          .setLabel("Full Time seat")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`ttrl_res_stay:${ftRoleId}:${reserveRoleId}`)
          .setLabel("Stay as Reserve")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`ttrl_res_leave:${ftRoleId}:${reserveRoleId}`)
          .setLabel("Leaving TTRL")
          .setStyle(ButtonStyle.Danger)
      );
    }

    return interaction.reply({
      content,
      components: [row],
      ephemeral: true,
    });
  }

  // Step 2: final answer buttons
  if (!baseId.startsWith("ttrl_")) return;

  // Before recording, check if this display name already submitted
  try {
    const already = await hasAlreadySubmitted(displayName);
    if (already) {
      return interaction.reply({
        content:
          "You've already submitted your TTRL signup. If you need to change your answer, please contact an admin.",
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error("Error checking existing submissions:", err);
    return interaction.reply({
      content:
        "I had trouble checking your existing signup. Please try again later or contact an admin.",
      ephemeral: true,
    });
  }

  let driverType = "Unknown";
  if (member.roles.cache.has(ftRoleId)) driverType = "FT";
  if (member.roles.cache.has(reserveRoleId)) driverType = "Reserve";

  let currentRole = "Unknown";
  if (driverType === "FT") currentRole = "Full Time Driver";
  else if (driverType === "Reserve") currentRole = "Reserve Driver";

  let choice;

  switch (baseId) {
    case "ttrl_ft_yes":
      choice = "Stay FT";
      break;
    case "ttrl_ft_reserve":
      choice = "Move to Reserve";
      break;
    case "ttrl_ft_leave":
      choice = "Leaving TTRL";
      break;
    case "ttrl_res_ft":
      choice = "Wants FT seat";
      break;
    case "ttrl_res_stay":
      choice = "Stay Reserve";
      break;
    case "ttrl_res_leave":
      choice = "Leaving TTRL";
      break;
    default:
      choice = "Unknown";
  }

  try {
await logToSheet({
  timestamp: formatTimestamp(),
  displayName,
  username: `${user.username}`,
  currentRole,
  driverType,
  membershipText,
  joinDate,
  userId,
  accountCreated,
  avatarUrl,
  allRoles,
  boostStatus,
  choice,
});

    // Refresh summary in the configured stats channel for this guild
    await updateSignupSummaryMessage(client, guildId);

    await interaction.reply({
      content: `Thanks! I've recorded your TTRL signup: **${choice}**. A confirmation has been sent to your DMs.`,
      ephemeral: true,
    });

    try {
      await user.send("Thank you, your TTRL signup request has been received.");
    } catch (dmErr) {
      console.error("Could not send DM to user:", dmErr.message);
    }
  } catch (err) {
    console.error("Error logging to sheet:", err);
    await interaction.reply({
      content:
        "I couldn't save your answer to the signup sheet. Please ping an admin.",
      ephemeral: true,
    });
  }
});

// ---------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------

client.login(process.env.DISCORD_TOKEN);
