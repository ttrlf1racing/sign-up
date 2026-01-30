Skip to content
ttrlf1racing
sign-up
Repository navigation
Code
Issues
Pull requests
Actions
Projects
Wiki
Security
1
 (1)
Insights
Settings
Commit 8712643
ttrlf1racing
ttrlf1racing
authored
47 minutes ago
·
·
Verified
Update index.js
main
1 parent 
5736db4
 commit 
8712643
File tree

index.js
1 file changed
+33
-18
lines changed

 
‎index.js‎
+33
-18
Lines changed: 33 additions & 18 deletions
Original file line number	Diff line number	Diff line change
@@ -473,24 +473,39 @@ client.on(Events.InteractionCreate, async (interaction) => {
        await updateSignupSummaryMessage(client, interaction.guildId);

        // === NEW: Leaving Channel Notification ===
        const LEAVING_CHANNEL_ID = process.env.LEAVING_CHANNEL_ID || "1460997377497239572";
        if (LEAVING_CHANNEL_ID) {
          try {
            const leavingChannel = interaction.guild.channels.cache.get(LEAVING_CHANNEL_ID);
            if (leavingChannel) {
              const embed = new EmbedBuilder()
                .setTitle("Driver Leaving TTRL")
                .setDescription(`${member} has indicated they wish to leave TTRL.`)
                .setColor(0xFF0000)  // Red for leaving
                .setTimestamp();
              await leavingChannel.send({ embeds: [embed] });
              console.log(`Leaving notification sent to ${leavingChannel.name} for ${displayName}`);
            }
          } catch (err) {
            console.error("Failed to send leaving notification:", err);
          }
        }
        // === END NEW ===
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
0 commit comments
Comments
0
 (0)
Comment
You're not receiving notifications from this thread.
