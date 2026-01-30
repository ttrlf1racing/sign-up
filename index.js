// ====================================================================
// TTRL SIGNUP BOT – OPTION A FLOW (SUNDAY + WEDNESDAY) + LEAVING + LEAVING NOTIF
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

const statsChannelByGuild = new Map(); // guild → stats channel
const autoRoleByChoice = new Map(); // choice → role ID
const pendingSignup = new Map(); // userId → { sundayChoice, guildId }

console.log("Google ENV:");
console.log(" GOOGLE_SPREADSHEET_ID:", SPREADSHEET_ID);
console.log(" GOOGLE_CLIENT_EMAIL:", process.env.GOOGLE_CLIENT_EMAIL);
console.log(" GOOGLE_PRIVATE_KEY length:", process.env.GOOGLE_PRIVATE_KEY?.length);

const googleAuth = new google.auth.GoogleAuth({
credentials: {
client_email: process.env.GOOGLE_CLIENT_EMAIL,
private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\\\n/g, "\\n"),
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
if (months === 0) return `${years} Years`;
return `${years} Years ${months}m`;
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
// SUMMARY – use Sunday Choice (F) for now
// ---------------------------------------------------------------------

async function getSignupSummaryFromSheets() {
const sheets = await getSheetsClient();
const res = await sheets.spreadsheets.values.get({
spreadsheetId: SPREADSHEET_ID,
range: "Sheet1!F:F" // F = Sunday Choice
});

const rows = res.data.values || [];
const summary = {
total: 0,
fullTimeSeat: 0,
reserveSeat: 0,
leaving: 0,
};

for (let i = 1; i < rows.length; i++) {
const [sundayChoice] = rows[i];
if (!sundayChoice) continue;
summary.total++;

if (sundayChoice.includes("Full Time")) summary.fullTimeSeat++;
else if (sundayChoice.includes("Reserve")) summary.reserveSeat++;
else if (sundayChoice === "Leaving TTRL") summary.leaving++;
}

return summary;
}

function formatSignupSummaryText(summary) {
return [
"**TTRL Signup Summary**",
"",
`Total responses: ${summary.total}`,
"",
`Full Time (Sunday): ${summary.fullTimeSeat}`,
`Reserve (Sunday): ${summary.reserveSeat}`,
`Leaving TTRL: ${summary.leaving}`,
].join("\\n");
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
// LOG TO SHEET – layout A:N
// ---------------------------------------------------------------------

async function logToSheet(entry) {
const sheets = await getSheetsClient();
const values = [[
entry.timestamp, // A
entry.displayName, // B
entry.username, // C
entry.tierRoles, // D
entry.realisticRoles, // E
entry.sundayChoice, // F
entry.wednesdayChoice, // G
entry.membershipText, // H
entry.joinDate, // I
entry.userId, // J
entry.accountCreated, // K
entry.avatarUrl, // L
entry.allRoles, // M
entry.boostStatus // N
]];

await sheets.spreadsheets.values.append({
spreadsheetId: SPREADSHEET_ID,
range: "Sheet1!A:N",
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
.setTitle("F125 Season 4 Sign-Up")
.setDescription([
"Welcome to the TTRL F125 Season 4 sign-up!",
"",
"Step 1: Choose your **Sunday Tier** status.",
"Step 2: Choose your **Wednesday Realistic** status.",
"",
"You can be Full Time, Reserve, or skip either day.",
"",
"If you are leaving the league, use the **Leaving TTRL** button below.",
].join("\\n"))
.setThumbnail("attachment://ttrl-logo.png")
.setColor(0xA020F0); // purple

const file = new AttachmentBuilder("ttrl-logo.png");

// Row 1 – Sunday options (Option A, first step)
const sundayRow = new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId("ttrlchoice|sunday|fulltime")
.setLabel("Sunday Tier – Full Time")
.setStyle(ButtonStyle.Success),
new ButtonBuilder()
.setCustomId("ttrlchoice|sunday|reserve")
.setLabel("Sunday Tier – Reserve")
.setStyle(ButtonStyle.Primary),
new ButtonBuilder()
.setCustomId("ttrlchoice|sunday|skip")
.setLabel("Skip Sunday")
.setStyle(ButtonStyle.Secondary),
);

// Row 2 – Leaving button (always visible, separate)
const leavingRow = new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId("ttrlchoice|leaving|start")
.setLabel("Leaving TTRL")
.setStyle(ButtonStyle.Danger),
);

await channel.send({
embeds: [embed],
components: [sundayRow, leavingRow],
files: [file]
});

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

const [base, section, action] = interaction.customId.split("|");
if (base !== "ttrlchoice") return;

const sundayLabelMap = {
fulltime: "Full Time Seat (Sunday)",
reserve: "Reserve Seat (Sunday)",
skip: "Not Participating (Sunday)"
};

const wedLabelMap = {
fulltime: "Full Time Seat (Wednesday)",
reserve: "Reserve Seat (Wednesday)",
skip: "Not Participating (Wednesday)"
};

// --------------------------------------------------------------
// LEAVING TTRL FLOW
// --------------------------------------------------------------
if (section === "leaving") {
if (action === "start") {
await interaction.reply({
content: "Are you sure you want to leave our great league?\\n\\nPlease note after clicking this button you will lose your current roles and be moved to the leaving channel.",
components: [
new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId("ttrlchoice|leaving|confirm")
.setLabel("Yes, I want to leave")
.setStyle(ButtonStyle.Danger),
new ButtonBuilder()
.setCustomId("ttrlchoice|leaving|cancel")
.setLabel("Cancel")
.setStyle(ButtonStyle.Secondary),
)
],
flags: 64,
});
return;
}

if (action === "cancel") {
await interaction.reply({
content: "Leaving cancelled. Your roles will not be changed.",
flags: 64,
});
return;
}

if (action === "confirm") {
await interaction.deferReply({ flags: 64 });

const user = interaction.user;
let member = interaction.member;
if (!member) {
member = await interaction.guild.members.fetch(user.id).catch(() => null);
}
if (!member) {
return interaction.editReply({ content: "Could not load your member data." });
}

const displayName = member.displayName || member.user.username;
const membershipText = formatMembership(member.joinedTimestamp || Date.now());

const rolesExcludingEveryone = member.roles.cache.filter(r => r.id !== interaction.guild.id);

console.log(`Member ${displayName} roles:`, rolesExcludingEveryone.map(r => r.name).join(", "));

const tierRolesArr = rolesExcludingEveryone
.filter(r => {
const name = r.name;
return name.includes("Tier") && (name.includes("- FT") || name.includes("- Res"));
})
.map(r => r.name);

const realisticRolesArr = rolesExcludingEveryone
.filter(r => {
const name = r.name;
return name.includes("Realistic") && (name.includes("- FT") || name.includes("- Res"));
})
.map(r => r.name);

const tierRoles = tierRolesArr.length > 0 ? tierRolesArr.join(", ") : "None";
const realisticRoles = realisticRolesArr.length > 0 ? realisticRolesArr.join(", ") : "None";

console.log(`Tier roles found: ${tierRoles}`);
console.log(`Realistic roles found: ${realisticRoles}`);

await logToSheet({
displayName,
username: user.username,
tierRoles,
realisticRoles,
sundayChoice: "Leaving TTRL",
wednesdayChoice: "Leaving TTRL",
timestamp: formatTimestamp(),
membershipText,
joinDate: member.joinedAt?.toISOString().split("T")[0] || "Unknown",
userId: member.id,
accountCreated: member.user.createdAt.toISOString().split("T")[0],
avatarUrl: member.user.displayAvatarURL({ size: 256 }),
allRoles: rolesExcludingEveryone.map(r => r.name).join(", ") || "None",
boostStatus: member.premiumSince ? `Since ${member.premiumSince.toISOString().split("T")[0]}` : "Not boosting"
});

await updateSignupSummaryMessage(client, interaction.guildId);

// === NEW: Leaving Channel Notification ===
const LEAVING_CHANNEL_ID = process.env.LEAVING_CHANNEL_ID;
console.log("Leaving debug – env LEAVING_CHANNEL_ID:", LEAVING_CHANNEL_ID);

try {
const guild = interaction.guild;
console.log("Leaving debug – guild id/name:", guild?.id, guild?.name);

const leavingChannel =
guild.channels.cache.get(LEAVING_CHANNEL_ID) ||
await guild.channels.fetch(LEAVING_CHANNEL_ID).catch(() => null);

console.log(
"Leaving debug – resolved channel:",
leavingChannel ? `${leavingChannel.id} / ${leavingChannel.name}` : "NONE"
);

if (leavingChannel && leavingChannel.isTextBased()) {
const embed = new EmbedBuilder()
.setTitle("Driver Leaving TTRL")
.setDescription(`${member} has indicated they wish to leave TTRL.`)
.setColor(0xFF0000)
.setTimestamp();

await leavingChannel.send({ embeds: [embed] });
console.log(`Leaving notification sent to ${leavingChannel.name} for ${displayName}`);
} else {
console.log("Leaving debug – channel not found or not text-based");
}
} catch (err) {
console.error("Failed to send leaving notification:", err);
}
// === END NEW ===


const leavingRoleId = "1460986192966455449";
const leavingRole = interaction.guild.roles.cache.get(leavingRoleId);

if (!leavingRole) {
console.error("Leaving role not found in guild:", leavingRoleId);
} else {
try {
const botMember = await interaction.guild.members.fetchMe();
const botPosition = botMember.roles.highest.position;

const rolesToRemove = member.roles.cache.filter(r =>
r.id !== interaction.guild.id &&
r.id !== leavingRoleId &&
r.position < botPosition
);

for (const [, role] of rolesToRemove) {
try {
await member.roles.remove(role);
} catch (err) {
console.error(`Failed to remove role ${role.name}:`, err);
}
}

if (leavingRole.position < botPosition && !member.roles.cache.has(leavingRoleId)) {
try {
await member.roles.add(leavingRole);
} catch (err) {
console.error("Failed to add Leaving role:", err);
}
} else if (leavingRole.position >= botPosition) {
console.error("Bot cannot manage Leaving role (position too high).");
}
} catch (err) {
console.error("Failed to update roles for Leaving TTRL:", err);
}
}

await interaction.editReply({
content: "Your choice **Leaving TTRL** has been recorded. A DM has been sent."
});

member.send("Your TTRL signup choice has been recorded as: Leaving TTRL.").catch(() => {});
return;
}

return;
}

// --------------------------------------------------------------
// SUNDAY / WEDNESDAY FLOW
// --------------------------------------------------------------

// SUNDAY STEP
if (section === "sunday") {
const sundayChoice = sundayLabelMap[action] || "Unknown (Sunday)";

pendingSignup.set(interaction.user.id, {
sundayChoice,
guildId: interaction.guildId,
});

const wedRow = new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId("ttrlchoice|wednesday|fulltime")
.setLabel("Wednesday Realistic – Full Time")
.setStyle(ButtonStyle.Success),
new ButtonBuilder()
.setCustomId("ttrlchoice|wednesday|reserve")
.setLabel("Wednesday Realistic – Reserve")
.setStyle(ButtonStyle.Primary),
new ButtonBuilder()
.setCustomId("ttrlchoice|wednesday|skip")
.setLabel("Skip Wednesday")
.setStyle(ButtonStyle.Secondary),
);

await interaction.reply({
content: `Sunday choice recorded: **${sundayChoice}**.\\nNow choose your **Wednesday Realistic** status:`,
components: [wedRow],
flags: 64,
});

return;
}

// WEDNESDAY STEP (finalise signup)
if (section === "wednesday") {
const pending = pendingSignup.get(interaction.user.id);
if (!pending || pending.guildId !== interaction.guildId) {
await interaction.reply({
content: "No Sunday choice found. Please click a Sunday option first.",
flags: 64,
});
return;
}

const wednesdayChoice = wedLabelMap[action] || "Unknown (Wednesday)";
const { sundayChoice } = pending;

pendingSignup.delete(interaction.user.id);

await interaction.deferReply({ flags: 64 });

const user = interaction.user;
let member = interaction.member;
if (!member) {
member = await interaction.guild.members.fetch(user.id).catch(() => null);
}
if (!member) {
return interaction.editReply({ content: "Could not load your member data." });
}

const displayName = member.displayName || member.user.username;
const membershipText = formatMembership(member.joinedTimestamp || Date.now());

if (await hasAlreadySubmitted(displayName)) {
return interaction.editReply({
content: "You have already submitted your signup."
});
}

const rolesExcludingEveryone = member.roles.cache.filter(r => r.id !== interaction.guild.id);

console.log(`Member ${displayName} roles:`, rolesExcludingEveryone.map(r => r.name).join(", "));

const tierRolesArr = rolesExcludingEveryone
.filter(r => {
const name = r.name;
return name.includes("Tier") && (name.includes("- FT") || name.includes("- Res"));
})
.map(r => r.name);

const realisticRolesArr = rolesExcludingEveryone
.filter(r => {
const name = r.name;
return name.includes("Realistic") && (name.includes("- FT") || name.includes("- Res"));
})
.map(r => r.name);

const tierRoles = tierRolesArr.length > 0 ? tierRolesArr.join(", ") : "None";
const realisticRoles = realisticRolesArr.length > 0 ? realisticRolesArr.join(", ") : "None";

console.log(`Tier roles found: ${tierRoles}`);
console.log(`Realistic roles found: ${realisticRoles}`);

await logToSheet({
displayName,
username: user.username,
tierRoles,
realisticRoles,
sundayChoice,
wednesdayChoice,
timestamp: formatTimestamp(),
membershipText,
joinDate: member.joinedAt?.toISOString().split("T")[0] || "Unknown",
userId: member.id,
accountCreated: member.user.createdAt.toISOString().split("T")[0],
avatarUrl: member.user.displayAvatarURL({ size: 256 }),
allRoles: rolesExcludingEveryone.map(r => r.name).join(", ") || "None",
boostStatus: member.premiumSince ? `Since ${member.premiumSince.toISOString().split("T")[0]}` : "Not boosting"
});

await updateSignupSummaryMessage(client, interaction.guildId);

// Optional auto-role keyed off Sunday summary (Full Time / Reserve)
let mainChoice = "Reserve Seat";
if (sundayChoice.includes("Full Time")) mainChoice = "Full Time Seat";
if (sundayChoice === "Leaving TTRL") mainChoice = "Leaving TTRL";

if (autoRoleByChoice.has(mainChoice)) {
const roleId = autoRoleByChoice.get(mainChoice);
try { await member.roles.add(roleId); }
catch (err) { console.error("Auto-role failed:", err.message); }
}

await interaction.editReply({
content: [
"Your signup has been recorded:",
`• Sunday: **${sundayChoice}**`,
`• Wednesday: **${wednesdayChoice}**`,
"",
].join("\\n")
});

member.send([
"Your TTRL signup has been recorded:",
`Sunday: ${sundayChoice}`,
`Wednesday: ${wednesdayChoice}`,
].join("\\n")).catch(() => {});

return;
}

return;

} catch (err) {
console.error("Interaction error:", err);
try {
if (interaction.deferred || interaction.replied) {
await interaction.editReply({ content: "Something went wrong." });
} else if (interaction.isRepliable()) {
await interaction.reply({ content: "Something went wrong.", flags: 64 });
}
} catch (_) {}
}
});

// =====================================================================
// LOGIN
// =====================================================================
client.login(process.env.DISCORD_TOKEN);
