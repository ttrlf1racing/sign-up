// Updated: 2025-12-05 (flexible option names)
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

// Map: guildId → stats channel id (set via /ttrl-signup)
const statsChannelByGuild = new Map();

// Map: choice → roleId (for optional auto-role assignment)
const autoRoleByChoice = new Map();

console.log('GOOGLE ENV:');
console.log('  GOOGLE_SPREADSHEET_ID:', SPREADSHEET_ID);
console.log('  GOOGLE_CLIENT_EMAIL:', process.env.GOOGLE_CLIENT_EMAIL);
console.log(
  '  GOOGLE_PRIVATE_KEY length:',
  process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.length : 'MISSING'
);

const googleAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY
      ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : undefined,
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

googleAuth
  .getClient()
  .then(() => console.log('Google Sheets auth OK (startup)'))
  .catch(err => {
    console.error('Google Sheets auth FAILED at startup');
    console.error(err);
  });

async function getSheetsClient() {
  const authClient = await googleAuth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// Nicely formatted timestamp: YYYY-MM-DD HH:MM:SS
function formatTimestamp(date = new Date()) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Convert membership duration to "years seasons / months" string
function formatMembership(joinedTimestamp) {
  const now = Date.now();
  const membershipMs = now - joinedTimestamp;
  const membershipDays = Math.max(0, Math.floor(membershipMs / (1000 * 60 * 60 * 24)));
  const years = Math.floor(membershipDays / 365);
  const remainingDays = membershipDays % 365;
  const months = Math.floor(remainingDays / 30);

  if (years === 0 && months === 0) return '<1m';
  if (years === 0) return `${months}m`;
  if (months === 0) return `${years} seasons`;
  return `${years} seasons ${months}m`;
}

// Check if a server display name has already submitted
async function hasAlreadySubmitted(displayName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!B:B',
  });
  const rows = res.data.values || [];
  return rows.some(row => row[0] === displayName);
}

// Read all answers from the sheet and build a summary object
async function getSignupSummaryFromSheets() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!E:M',
  });
  const rows = res.data.values || [];

  let startIndex = 0;
  if (rows.length && rows[0][0] === 'Driver Type') {
    startIndex = 1;
  }

  const summary = {
    total: 0,
    ft: { stay: 0, reserve: 0, leave: 0 },
    res: { wantsFt: 0, stay: 0, leave: 0 },
  };

  for (let i = startIndex; i < rows.length; i++) {
    const [driverType, , , , , , , , answer] = rows[i];
    if (!driverType || !answer) continue;

    summary.total++;

    if (driverType === 'FT') {
      if (answer === 'Stay FT') summary.ft.stay++;
      else if (answer === 'Move to Reserve') summary.ft.reserve++;
      else if (answer === 'Leaving TTRL') summary.ft.leave++;
    } else if (driverType === 'Reserve') {
      if (answer === 'Wants FT seat') summary.res.wantsFt++;
      else if (answer === 'Stay Reserve') summary.res.stay++;
      else if (answer === 'Leaving TTRL') summary.res.leave++;
    }
  }

  return summary;
}

// Turn the summary object into a nice text block
function formatSignupSummaryText(summary) {
  return [
    '**TTRL Signup Summary**',
    '',
    `Total responses: ${summary.total}`,
    '',
    '**Full Time Drivers:**',
    `  Stay FT: ${summary.ft.stay}`,
    `  Move to Reserve: ${summary.ft.reserve}`,
    `  Leaving TTRL: ${summary.ft.leave}`,
    '',
    '**Reserve Drivers:**',
    `  Wants FT seat: ${summary.res.wantsFt}`,
    `  Stay Reserve: ${summary.res.stay}`,
    `  Leaving TTRL: ${summary.res.leave}`,
  ].join('\n');
}

// Update or create the summary message in the guild's stats channel
async function updateSignupSummaryMessage(client, guildId) {
  const channelId = statsChannelByGuild.get(guildId);
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const summary = await getSignupSummaryFromSheets();
  const text = formatSignupSummaryText(summary);

  const messages = await channel.messages.fetch({ limit: 20 });
  const existing = messages.find(
    m => m.author.id === client.user.id && m.content.startsWith('**TTRL Signup Summary**')
  );

  if (existing) {
    await existing.edit(text);
  } else {
    await channel.send(text);
  }
}

// Log one answer into the sheet
async function logToSheet(entry) {
  console.log('logToSheet called with:', entry);
  const sheets = await getSheetsClient();

  const values = [
    [
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
      entry.choice,
    ],
  ];

  try {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:M',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
    console.log('Sheets append result:', res.status, res.statusText);
  } catch (err) {
    console.error('Sheets append threw error:');
    console.error(err);
    throw err;
  }
}

// ---------------------------------------------------------------------
// DISCORD CLIENT
// ---------------------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

// ---------------------------------------------------------------------
// INTERACTION HANDLER (wrapped in try/catch)
// ---------------------------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // -----------------------------------------------------------------
    // SLASH COMMANDS
    // -----------------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      
      // Command: /ttrl-signup
      if (interaction.commandName === 'ttrl-signup') {
        if (!interaction.inGuild()) {
          return interaction.reply({ content: 'Use this command in a server channel.', ephemeral: true });
        }

        const perms = interaction.memberPermissions;
        const isAdminLike =
          perms &&
          (perms.has(PermissionsBitField.Flags.Administrator) ||
            perms.has(PermissionsBitField.Flags.ManageGuild));

        if (!isAdminLike) {
          return interaction.reply({ content: 'Only admins can post the TTRL signup panel.', ephemeral: true });
        }

        // Try by name first
        let ftRole = interaction.options.getRole('ftrole');
        let reserveRole = interaction.options.getRole('reserverole');
        let statsChannel = interaction.options.getChannel('statschannel');

        // Fallback: infer from options (first 2 roles, first channel)
        const hoisted = interaction.options._hoistedOptions || [];
        const roleOpts = hoisted.filter(o => o.role).map(o => o.role);
        const chanOpts = hoisted.filter(o => o.channel).map(o => o.channel);

        if (!ftRole && roleOpts[0]) ftRole = roleOpts[0];
        if (!reserveRole && roleOpts[1]) reserveRole = roleOpts[1];
        if (!statsChannel && chanOpts[0]) statsChannel = chanOpts[0];

        if (!ftRole || !reserveRole || !statsChannel) {
          console.log('ttrl-signup options debug:', hoisted.map(o => ({
            name: o.name,
            hasRole: !!o.role,
            hasChannel: !!o.channel,
            value: o.value,
            type: o.type
          })));
          return interaction.reply({
            content:
              'This command appears to be misconfigured. It should have **two role options** (FT and Reserve) and **one channel option** (stats channel).',
            ephemeral: true,
          });
        }

        if (!statsChannel.isTextBased()) {
          return interaction.reply({ content: 'The stats channel must be a normal text channel.', ephemeral: true });
        }

        statsChannelByGuild.set(interaction.guildId, statsChannel.id);

        let channel = null;
        try {
          channel = await client.channels.fetch(interaction.channelId);
        } catch {
          channel = null;
        }

        if (!channel || !channel.isTextBased()) {
          return interaction.reply({
            content: "I couldn't post in that channel. Please use a normal text channel I can send messages in.",
            ephemeral: true,
          });
        }

        const file = new AttachmentBuilder('ttrl-logo.png');
        const embed = new EmbedBuilder()
          .setTitle('TTRL Sign-Up Process')
          .setDescription(
            "Welcome to the TTRL sign-up process! As we approach our new season, we need to confirm each driver's intentions for the upcoming season. Please select an option below and follow the prompts. Thank you."
          )
          .setColor(0xffcc00)
          .setThumbnail('attachment://ttrl-logo.png');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ttrlopen|ft|${ftRole.id}|${reserveRole.id}`)
            .setLabel('Current Full Time Driver')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`ttrlopen|res|${ftRole.id}|${reserveRole.id}`)
            .setLabel('Current Reserve')
            .setStyle(ButtonStyle.Secondary)
        );

        try {
          await channel.send({ embeds: [embed], components: [row], files: [file] });
          await interaction.reply({ content: 'Signup panel posted in this channel and stats channel saved.', ephemeral: true });
          await updateSignupSummaryMessage(client, interaction.guildId);
        } catch (err) {
          console.error('Error sending panel message:', err);
          await interaction.reply({
            content: "I couldn't post in this channel. Please check my permissions and try again.",
            ephemeral: true,
          });
        }
        return;
      }
      
      // Command: /ttrl-set-autorole
      else if (interaction.commandName === 'ttrl-set-autorole') {
        if (!interaction.inGuild()) {
          return interaction.reply({ content: 'Use this command in a server channel.', ephemeral: true });
        }

        const perms = interaction.memberPermissions;
        const isAdminLike =
          perms &&
          (perms.has(PermissionsBitField.Flags.Administrator) ||
            perms.has(PermissionsBitField.Flags.ManageGuild));

        if (!isAdminLike) {
          return interaction.reply({ content: 'Only admins can configure auto-roles.', ephemeral: true });
        }

        // Try canonical names
        let choice = interaction.options.getString('choice');
        let role = interaction.options.getRole('role');

        // Fallback: infer from options
        const hoisted = interaction.options._hoistedOptions || [];
        if (!choice) {
          const strOpt = hoisted.find(o => typeof o.value === 'string' && !o.role && !o.channel);
          if (strOpt) choice = strOpt.value;
        }
        if (!role) {
          const rOpt = hoisted.find(o => o.role);
          if (rOpt) role = rOpt.role;
        }

        if (!choice) {
          console.log('ttrl-set-autorole options debug:', hoisted.map(o => ({
            name: o.name,
            hasRole: !!o.role,
            value: o.value,
            type: o.type
          })));
          return interaction.reply({
            content: 'This command is missing a **string** option for the choice text.',
            ephemeral: true,
          });
        }

        if (!role) {
          // No role = disable mapping
          autoRoleByChoice.delete(choice);
          return interaction.reply({ 
            content: `✅ Automatic role assignment **disabled** for: **${choice}**`, 
            ephemeral: true 
          });
        }

        autoRoleByChoice.set(choice, role.id);
        console.log(`Auto-role configured: "${choice}" → ${role.id}`);

        return interaction.reply({ 
          content: `✅ Users who choose **${choice}** will automatically receive the **${role.name}** role.`, 
          ephemeral: true 
        });
      }
      
      return;
    }

    // -----------------------------------------------------------------
    // BUTTONS
    // -----------------------------------------------------------------
    if (!interaction.isButton()) return;

    // All customIds are of the form:
    // - ttrlopen|ft|<ftRoleId>|<reserveRoleId>
    // - ttrlopen|res|<ftRoleId>|<reserveRoleId>
    // - ttrlft|yes|<ftRoleId>|<reserveRoleId>
    // - ttrlft|reserve|<ftRoleId>|<reserveRoleId>
    // - ttrlft|leave|<ftRoleId>|<reserveRoleId>
    // - ttrlres|ft|<ftRoleId>|<reserveRoleId>
    // - ttrlres|stay|<ftRoleId>|<reserveRoleId>
    // - ttrlres|leave|<ftRoleId>|<reserveRoleId>

    const parts = interaction.customId.split('|');
    const baseId = parts[0];          // ttrlopen / ttrlft / ttrlres
    const actionOrType = parts[1];    // ft / res / yes / reserve / leave / stay
    const ftRoleId = parts[2];        // actual FT role id
    const reserveRoleId = parts[3];   // actual Reserve role id

    const user = interaction.user;

    // Ensure we have a full GuildMember
    let member = interaction.member;
    if (!member || !interaction.guild) {
      try {
        member = await interaction.guild.members.fetch(user.id);
      } catch {
        member = null;
      }
    }

    if (!member) {
      return interaction.reply({ content: "I couldn't load your server info. Please try again or contact an admin.", ephemeral: true });
    }

    const guildId = interaction.guildId;

    // Server display name (nickname or username)
    const displayName = member.displayName || user.username;

    // How long in server (seasons & months)
    const joinedTs = member.joinedTimestamp || Date.now();
    const membershipText = formatMembership(joinedTs);

    // Collect additional user data
    const userId = user.id;
    const accountCreated = user.createdAt.toISOString().split('T')[0];
    const avatarUrl = user.displayAvatarURL({ dynamic: true, size: 256 });
    const allRoles = member.roles.cache.map(r => r.name).filter(n => n !== '@everyone').join(', ') || 'None';
    const boostStatus = member.premiumSince ? `Boosting since ${member.premiumSince.toISOString().split('T')[0]}` : 'Not boosting';
    const joinDate = member.joinedAt ? member.joinedAt.toISOString().split('T')[0] : 'Unknown';

    // Step 1 panel buttons: Current FT / Current Reserve
    if (baseId === 'ttrlopen') {
      const driverTypeKey = actionOrType; // 'ft' or 'res'
      const isFT = member.roles.cache.has(ftRoleId);
      const isReserve = member.roles.cache.has(reserveRoleId);

      if (driverTypeKey === 'ft' && !isFT) {
        return interaction.reply({ content: 'You clicked "Current Full Time Driver", but you don\'t have the FT driver role.', ephemeral: true });
      }
      if (driverTypeKey === 'res' && !isReserve) {
        return interaction.reply({ content: 'You clicked "Current Reserve", but you don\'t have the Reserve driver role.', ephemeral: true });
      }

      let content;
      let row;

      if (driverTypeKey === 'ft') {
        content = 'For current Drivers with a Full Time seat: Do you wish a FT seat for next season?';
        row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ttrlft|yes|${ftRoleId}|${reserveRoleId}`)
            .setLabel('Yes, keep FT seat')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`ttrlft|reserve|${ftRoleId}|${reserveRoleId}`)
            .setLabel('Move to Reserve')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`ttrlft|leave|${ftRoleId}|${reserveRoleId}`)
            .setLabel('Leaving TTRL')
            .setStyle(ButtonStyle.Danger)
        );
      } else {
        content = 'For Reserve Drivers: What are you looking for next season?';
        row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ttrlres|ft|${ftRoleId}|${reserveRoleId}`)
            .setLabel('Full Time seat')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`ttrlres|stay|${ftRoleId}|${reserveRoleId}`)
            .setLabel('Stay as Reserve')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`ttrlres|leave|${ftRoleId}|${reserveRoleId}`)
            .setLabel('Leaving TTRL')
            .setStyle(ButtonStyle.Danger)
        );
      }

      return interaction.reply({ content, components: [row], ephemeral: true });
    }

    // Step 2: final answer buttons
    if (!baseId.startsWith('ttrl')) return;

    // Before recording, check if this display name already submitted
    try {
      const already = await hasAlreadySubmitted(displayName);
      if (already) {
        return interaction.reply({
          content: "You've already submitted your TTRL signup. If you need to change your answer, please contact an admin.",
          ephemeral: true,
        });
      }
    } catch (err) {
      console.error('Error checking existing submissions:', err);
      return interaction.reply({
        content: "I had trouble checking your existing signup. Please try again later or contact an admin.",
        ephemeral: true,
      });
    }

    let driverType = 'Unknown';
    if (member.roles.cache.has(ftRoleId)) driverType = 'FT';
    if (member.roles.cache.has(reserveRoleId)) driverType = 'Reserve';

    let currentRole = 'Unknown';
    if (driverType === 'FT') currentRole = 'Full Time Driver';
    else if (driverType === 'Reserve') currentRole = 'Reserve Driver';

    let choice;

    if (baseId === 'ttrlft') {
      const ftAction = actionOrType; // yes / reserve / leave
      if (ftAction === 'yes') choice = 'Stay FT';
      else if (ftAction === 'reserve') choice = 'Move to Reserve';
      else if (ftAction === 'leave') choice = 'Leaving TTRL';
    } else if (baseId === 'ttrlres') {
      const resAction = actionOrType; // ft / stay / leave
      if (resAction === 'ft') choice = 'Wants FT seat';
      else if (resAction === 'stay') choice = 'Stay Reserve';
      else if (resAction === 'leave') choice = 'Leaving TTRL';
    }

    try {
      await logToSheet({
        displayName,
        username: user.username,
        currentRole,
        driverType,
        choice,
        timestamp: formatTimestamp(),
        membershipText,
        userId,
        accountCreated,
        avatarUrl,
        allRoles,
        boostStatus,
        joinDate,
      });

      // Refresh summary in the configured stats channel for this guild
      await updateSignupSummaryMessage(client, guildId);

      // Apply auto-role if configured for this choice
      if (autoRoleByChoice.has(choice)) {
        const roleId = autoRoleByChoice.get(choice);
        try {
          await member.roles.add(roleId);
          console.log(`✅ Auto-assigned role ${roleId} to ${displayName} for choice: ${choice}`);
        } catch (roleErr) {
          console.error(`❌ Failed to assign auto-role ${roleId}:`, roleErr.message);
          // Don't fail the whole interaction if role assignment fails
        }
      } else {
        console.log(`ℹ️ No auto-role configured for choice: ${choice}`);
      }

      await interaction.reply({
        content: "Thanks! I've recorded your TTRL signup choice. A confirmation has been sent to your DMs.",
        ephemeral: true,
      });

      try {
        await user.send('Thank you, your TTRL signup request has been received.');
      } catch (dmErr) {
        console.error('Could not send DM to user:', dmErr.message);
      }
    } catch (err) {
      console.error('Error logging to sheet:', err);
      await interaction.reply({
        content: "I couldn't save your answer to the signup sheet. Please ping an admin.",
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error('Unhandled error in InteractionCreate handler:', err);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            content: 'Something went wrong handling that interaction.',
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: 'Something went wrong handling that interaction.',
            ephemeral: true,
          });
        }
      }
    } catch (replyErr) {
      console.error('Failed to reply after error:', replyErr);
    }
  }
});

// ---------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------
client.login(process.env.DISCORD_TOKEN);
