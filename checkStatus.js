const conf = require("ocore/conf.js");
const device = require('ocore/device.js');

const { getAllDonors, updateDonorRole } = require("./db/api");
const discordInstance = require("./discordInstance");
const { getRoleByWalletAddress } = require("./utils/getRoleByWalletAddress");
const { sendToChannel } = require("./utils/sendToChannel");
const { retry } = require("./utils/retry");

// every request is retried once, if it fails again the error crashes the process
const checkAndUpdateStatus = async () => {
  const donors = await getAllDonors();
  const guild = await retry(() => discordInstance.guilds.fetch(conf.SERVER_ID));

  console.error('Update time: ', Date.now());

  for (let i = 0; i < donors.length; i++) {
    const donor = donors[i]; // actualRole = conf.discordRoles[2] // for test
    const actualRole = await retry(() => getRoleByWalletAddress(donor.donor));

    if (actualRole && String(donor.role_id) !== String(actualRole.id)) {
      // null if the user is no longer on the server (10007 - Unknown Member)
      const member = await retry(() => guild.members.fetch({ user: String(donor.user_id), force: true }).catch(e => {
        if (e.code === 10007) return null;
        throw e;
      }));
      const user = member?.user;

      if (user) {
        console.error('user', user.globalName + ' -> ' + actualRole.name);

        const oldRole = await retry(() => guild.roles.fetch(donor.role_id));
        const newRole = await retry(() => guild.roles.fetch(actualRole.id));

        if (oldRole) await retry(() => member.roles.remove(oldRole)); // the role may have been deleted on the server

        await retry(() => member.roles.add(newRole));

        await updateDonorRole(donor.donor, actualRole.id);

        device.sendMessageToDevice(donor.device_address, 'text', `Your new discord status: ${newRole.name}`);

        await sendToChannel(user.globalName || user.username, actualRole);
      }
    }
  }
}

exports.checkAndUpdateStatus = checkAndUpdateStatus;
