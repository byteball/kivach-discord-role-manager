const conf = require('ocore/conf');
const eventBus = require('ocore/event_bus.js');
const device = require('ocore/device.js');
const network = require('ocore/network.js');
const headlessWallet = require('headless-obyte');
const db = require('./db/index.js');
const { EmbedBuilder } = require('discord.js');

const discordInstance = require('./discordInstance');
const { isValidAddress } = require('ocore/validation_utils');
const { getRoleByWalletAddress } = require('./utils/getRoleByWalletAddress.js');
const { addDonor, getNickDataByWallet, removeDonor } = require('./db/api.js');

const sessions = {} // device_address: { wallet: 'ADDRESS', signed: bool, role: roleObject from conf.js }

const texts = {
  INSERT_ADDRESS: "Please insert your donor address (click ... and \"Insert my address\")",
  NOT_FOUND_ADDRESS: "Sorry we can't find your address in kivach donors database. Please try again.",
  SEND_NICK: "Please send your discord nick (in Obyte server)",
  LAST_NICK: (nick) => `Your last discord nick was ${nick}. We will remove it.`,
  ALREADY_HAVE_STATUS: "You already have this status.",
  UPDATED: "Your discord status has been updated.",
  NOT_FOUND_NICK: "We could not find your discord nick (in Obyte server). Please try again.",
  SIGN_MESSAGE: (wallet) => `[${wallet}](sign-message-request: I own the address ${wallet})`,
  SIGN_MESSAGE_ERROR: "Please sign the message to prove that you own the address.",
}

eventBus.once('headless_wallet_ready', () => {
  headlessWallet.setupChatEventHandlers();

  eventBus.once('connected', async function (ws) {
    network.initWitnessesIfNecessary(ws, start);
  });

  eventBus.on('paired', (from_address) => {
    device.sendMessageToDevice(from_address, 'text', texts.INSERT_ADDRESS);
  });

  // a. User send address
  // b. User send signed message
  // c. User send nickname

  eventBus.on('text', async (from_address, data) => {
    let arrSignedMessageMatches = data.match(/\(signed-message:(.+?)\)/);

    const trimmedData = data.trim();
    let wallet = null;
    let nick = null;

    // a) User send address
    // Return: if we find address we send to message to sign or error "We can't find your address in kivach donors database. Please try again."

    if (isValidAddress(trimmedData)) {
      wallet = trimmedData;

      const role = await getRoleByWalletAddress(wallet);

      if (role) {
        sessions[from_address] = { wallet, role, signed: false };
        device.sendMessageToDevice(from_address, 'text', texts.SIGN_MESSAGE(wallet));
      } else {
        device.sendMessageToDevice(from_address, 'text', texts.NOT_FOUND_ADDRESS);
      }

    } else if (data.startsWith("[Signed message]")) {
      // b) User send signed message
      // Return: if we find address and signed message is correct we send message "Please send your discord nick (in Obyte server)" or error "Please sign the message to prove that you own the address."

      let signedMessageBase64 = arrSignedMessageMatches[1];

      let validation = require('ocore/validation.js');

      let signedMessageJson = Buffer.from(signedMessageBase64, 'base64').toString('utf8');
      let objSignedMessage;

      try {
        objSignedMessage = JSON.parse(signedMessageJson);
      } catch (e) {
        return device.sendMessageToDevice(from_address, 'text', texts.SIGN_MESSAGE_ERROR);;
      }

      validation.validateSignedMessage(objSignedMessage, err => {
        if (from_address in sessions) { // already sent address
          if (!err && objSignedMessage.authors && objSignedMessage.authors.length && sessions[from_address].wallet === objSignedMessage.authors[0].address) {
            // signed correctly
            sessions[from_address] = { ...sessions[from_address], signed: true };
            device.sendMessageToDevice(from_address, 'text', texts.SEND_NICK);
          } else {
            // signed incorrectly
            device.sendMessageToDevice(from_address, 'text', texts.SIGN_MESSAGE_ERROR);
          }
        } else { // not sent address
          device.sendMessageToDevice(from_address, 'text', texts.INSERT_ADDRESS);
        }
      });

    } else if (trimmedData && (from_address in sessions)) {
      // c. User send nickname

      nick = trimmedData;

      const wallet = sessions[from_address].wallet;
      const signed = sessions[from_address].signed;

      const roleId = sessions[from_address].role?.id;

      if (wallet && signed && roleId) {
        // we have all data

        // common data
        const members = await discordInstance.guilds.fetch(conf.SERVER_ID).then(data => data.members.fetch());
        const membersData = members.toJSON().map(member => ({ ...member.user }));

        // user data (from discord api) by nickname
        const user = membersData.find(({ username }) => username.toLowerCase() === nick.toLowerCase());



        if (user) {
          const lastNickData = await getNickDataByWallet(wallet);

          if (lastNickData) {
            // remove last nick role

            try {
              const lastMemberData = membersData.find(({ id }) => id === lastNickData.user_id);

              if (lastMemberData) {
                // last user still in discord server

                if (lastMemberData.id === user.id && lastNickData.role_id === roleId) {
                  return device.sendMessageToDevice(from_address, 'text', texts.ALREADY_HAVE_STATUS);
                } else {
                  device.sendMessageToDevice(from_address, 'text', texts.LAST_NICK(lastNickData.nick_name));

                  const guild = await discordInstance.guilds.fetch(conf.SERVER_ID);

                  const role = await guild.roles.fetch(lastNickData.role_id);
                  const lastMember = members.get(lastMemberData.id);

                  await lastMember.roles.remove(role);

                  await removeDonor(lastNickData.donor);
                }
              }
            } catch (e) {
              return console.error("Can't remove role", e);
            }
          }

          // update role process
          try {
            const guild = await discordInstance.guilds.fetch(conf.SERVER_ID);
            const member = members.get(user.id);
            const role = await guild.roles.fetch(roleId);

            await member.roles.add(role);

            await addDonor(wallet, nick, role.id, user.id);

            device.sendMessageToDevice(from_address, 'text', texts.UPDATED);

            if (process.env.CHANNEL_ID) {
              try {
                const channel = await discordInstance.channels.fetch(process.env.CHANNEL_ID);
                const embed = new EmbedBuilder()
                  .setTitle(`${user.globalName} became the “${role.name}”`)
                  .setDescription(`You can get this role too. If you already donated you can send your address to the ${conf.deviceName} and get it or you may [Donate now](https://kivach.org).`)
                  .setAuthor({ name: "Kivach roles bot", url: "https://kivach.org" })
                  .setColor(role.color);

                await channel.send({ embeds: [embed] });
              } catch (e) {
                console.error("Can't send message to channel", e)
              }
            }
          } catch (e) {
            console.log("Can't add role", e);
          }

          delete sessions[from_address];

        } else {
          device.sendMessageToDevice(from_address, 'text', texts.NOT_FOUND_NICK);
        }

      } else {
        device.sendMessageToDevice(from_address, 'text', texts.INSERT_ADDRESS);
      }
    }
  });
});



async function start() {
  await discordInstance.login(conf.BOT_TOKEN);

  await db.create(); // create db if not exists
}