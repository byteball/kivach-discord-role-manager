const conf = require("ocore/conf.js");
const device = require('ocore/device.js');

const { getAllDonors, updateDonorRole } = require("./db/api");
const discordInstance = require("./discordInstance");
const { getRoleByWalletAddress } = require("./utils/getRoleByWalletAddress");
const { sendToChannel } = require("./utils/sendToChannel");

const checkAndUpdateStatus = async () => {
  const donors = await getAllDonors();
  const guild = await discordInstance.guilds.fetch(conf.SERVER_ID);

  console.error('Update time: ', Date.now());

  for (let i = 0; i < donors.length; i++) {
    const donor = donors[i]; // actualRole = conf.discordRoles[2] // for test

    // one failed donor must not stop the check for the others
    try {
      await updateDonorStatus(guild, donor);
    } catch (e) {
      console.error("Can't update status", e, donor.donor);
    }
  }
}

const updateDonorStatus = async (guild, donor) => {
  const actualRole = await getRoleByWalletAddress(donor.donor);

  if (actualRole && String(donor.role_id) !== String(actualRole.id)) {
    // null if the user is no longer on the server (10007 - Unknown Member)
    const member = await guild.members.fetch({ user: String(donor.user_id), force: true }).catch(e => {
      if (e.code === 10007) return null;
      throw e;
    });
    const user = member?.user;

    if (user) {
      console.error('user', user.globalName + ' -> ' + actualRole.name);

      const oldRole = await guild.roles.fetch(donor.role_id);
      const newRole = await guild.roles.fetch(actualRole.id);

      try {
        await member.roles.remove(oldRole);
      } catch (e) {
        console.error("Can't remove role", e, donor.donor);
      }

      await member.roles.add(newRole);

      await updateDonorRole(donor.donor, actualRole.id);

      device.sendMessageToDevice(donor.device_address, 'text', `Your new discord status: ${newRole.name}`);

      await sendToChannel(user.globalName || user.username, actualRole);
    }
  }
}

exports.checkAndUpdateStatus = checkAndUpdateStatus;