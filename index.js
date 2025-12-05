// ====================================================================
//  TTRL SIGNUP BOT - FULL UPDATED VERSION (2025-12-05)
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

  // Paginate up to 500 messages to find previous summary
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
        let ftRole = interaction.options.getRole("ftrole");
        let reserveRole = interaction.options.getRole("reserverole");
        let statsChannel = interaction.options.getChannel("statschannel");

        // Fallback: detect automatically
        const hoisted = interaction.options._hoistedOptions ?? [];
        const roleOptions = hoisted.filter(o => o.role).map(o => o.role);
        const chanOptions = hoisted.filter(o => o.channel).map(o => o.channel);

        if (!ftRole && roleOptions[0]) ftRole = roleOptions[0];
        if (!reserveRole && roleOptions[1]) reserveRole = roleOptions[1];
        if (!statsChannel && chanOptions[0]) statsChannel = chanOptions[0];

        if (!ftRole || !reserveRole || !statsChannel) {
          return interaction.reply({
            content: "This command must include **two role options** (FT + Reserve) and **one channel option** (stats).",
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

        // EMBED WITH RESTORED FORMATTING
        const embed = new EmbedBuilder()
          .setTitle("TTRL Sign-Up Process")
          .setDescription([
            "Welcome to the TTRL sign-up process!",
            "",
            "As we approach our new season, we need to confirm each driver's intentions for the upcoming season.",
            "",
            "Please select an option below and follow the prompts.",
            "",
            "Thank you."
          ].join("\n"))
          .setThumbnail("attachment://ttrl-logo.png")
          .setColor(0xffcc00);

        const file = new AttachmentBuilder("ttrl-logo.png");

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ttrlopen|ft|${ftRole.id}|${reserveRole.id}`)
            .setLabel("Current Full Time Driver")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`ttrlopen|res|${ftRole.id}|${reserveRole.id}`)
            .setLabel("Current Reserve")
            .setStyle(ButtonStyle.Secondary),
        );

        await channel.send({ embeds: [embed], components: [row], files: [file] });
        await interaction.reply({ content: "Signup panel posted.", ephemeral: true });
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
          return interaction.reply({ content: "Admins only.", ephemeral: true });
        }

        let choice = interaction.options.getString("choice");
        let role = interaction.options.getRole("role");

        // fallback detection
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

    const [base, action, ftRoleId, reserveRoleId] = interaction.customId.split("|");
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

    // ------------------------------------------------
    // STEP 1 PANEL: CHOOSE FT OR RESERVE
    // ------------------------------------------------
    if (base === "ttrlopen") {
      const isFT = member.roles.cache.has(ftRoleId);
      const isRes = member.roles.cache.has(reserveRoleId);

      if (action === "ft" && !isFT) {
        return interaction.reply({ content: "You do not have the FT role.", ephemeral: true });
      }
      if (action === "res" && !isRes) {
        return interaction.reply({ content: "You do not have the Reserve role.", ephemeral: true });
      }

      let content;
      let row;

      if (action === "ft") {
        content = "For FT drivers: What do you want to do next season?";
        row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ttrlft|yes|${ftRoleId}|${reserveRoleId}`).setLabel("Stay FT").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`ttrlft|reserve|${ftRoleId}|${reserveRoleId}`).setLabel("Move to Reserve").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`ttrlft|leave|${ftRoleId}|${reserveRoleId}`).setLabel("Leaving TTRL").setStyle(ButtonStyle.Danger),
        );
      } else {
        content = "For Reserve drivers: What do you want to do next season?";
        row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ttrlres|ft|${ftRoleId}|${reserveRoleId}`).setLabel("Want FT seat").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`ttrlres|stay|${ftRoleId}|${reserveRoleId}`).setLabel("Stay Reserve").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`ttrlres|leave|${ftRoleId}|${reserveRoleId}`).setLabel("Leaving TTRL").setStyle(ButtonStyle.Danger),
        );
      }

      return interaction.reply({ content, components: [row], ephemeral: true });
    }


    // ------------------------------------------------
    // STEP 2 PANEL: FINAL SELECTION
    // ------------------------------------------------

    // Prevent duplicate submissions
    if (await hasAlreadySubmitted(displayName)) {
      return interaction.reply({
        content: "You have already submitted your signup.",
        ephemeral: true
      });
    }

    let driverType = "Unknown";
    if (member.roles.cache.has(ftRoleId)) driverType = "FT";
    if (member.roles.cache.has(reserveRoleId)) driverType = "Reserve";

    let currentRole =
      driverType === "FT" ? "Full Time Driver" :
      driverType === "Reserve" ? "Reserve Driver" :
      "Unknown";

    let choice;

    if (base === "ttrlft") {
      if (action === "yes") choice = "Stay FT";
      if (action === "reserve") choice = "Move to Reserve";
      if (action === "leave") choice = "Leaving TTRL";
    }
    if (base === "ttrlres") {
      if (action === "ft") choice = "Wants FT seat";
      if (action === "stay") choice = "Stay Reserve";
      if (action === "leave") choice = "Leaving TTRL";
    }

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

    // AUTO-ROLE
    if (autoRoleByChoice.has(choice)) {
      const roleId = autoRoleByChoice.get(choice);
      try { await member.roles.add(roleId); }
      catch (err) { console.error("Auto-role failed:", err.message); }
    }

    await interaction.reply({
      content: "Your signup has been recorded. A DM has been sent.",
      ephemeral: true
    });

    member.send("Your TTRL signup has been received.").catch(() => {});

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

