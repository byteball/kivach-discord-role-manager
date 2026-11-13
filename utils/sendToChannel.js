const { EmbedBuilder } = require("discord.js");
const conf = require('ocore/conf');

const discordInstance = require("../discordInstance");

async function sendToChannel(userGlobalName, role) {
  if (process.env.CHANNEL_ID) {
    const channel = await discordInstance.channels.fetch(process.env.CHANNEL_ID);

    const roleFields = conf.discordRoles.sort((a, b) => a.minimum_usd_donation - b.minimum_usd_donation).map(role => ({
      name: role.name, value: `Min. $${role.minimum_usd_donation}`, inline: false
    }));

    const embed = new EmbedBuilder()
      .setTitle(`@${userGlobalName} is now “${role.name}”`)
      .setDescription(`You can get a similar role in this Discord server too. If you have already donated at least $0.10, talk to [${conf.deviceName}](${conf.kivach_invite_to_bot_url}) to link your Obyte adddress to your Discord username. Otherwise, [Donate](https://kivach.org) to a project of your choice first.`)
      .setAuthor({ name: "Kivach", url: "https://kivach.org" })
      .setColor(role.color)
      .setFields(roleFields);

    await channel.send({ embeds: [embed] });
  }
}

exports.sendToChannel = sendToChannel;
