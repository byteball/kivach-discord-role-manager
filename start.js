// must be loaded before ocore: ocore/storage.js freezes String.prototype, which breaks @vladfrangu/async_event_emitter (used by discord.js)
require('discord.js');
const conf = require('ocore/conf');
const eventBus = require('ocore/event_bus.js');
const device = require('ocore/device.js');
const network = require('ocore/network.js');
const headlessWallet = require('headless-obyte');
const db = require('./db/index.js');

const discordInstance = require('./discordInstance');
const { isValidAddress } = require('ocore/validation_utils');
const { getRoleByWalletAddress } = require('./utils/getRoleByWalletAddress.js');
const { sendToChannel } = require('./utils/sendToChannel.js');
const { addDonor, getNickDataByWallet, removeDonor } = require('./db/api.js');
const { checkAndUpdateStatus } = require('./checkStatus.js');

const sessions = {} // device_address: { wallet: 'ADDRESS', signed: bool, role: roleObject from conf.js }

const CHECK_INTERVAL = 1000 * 60 * 60 * 4; // 4 hours

const texts = {
  GREETING: `Welcome to Kivach discord bot. Here you can link your discord nickname to your Obyte address and have your status displayed on Discord depending on the total amount of your donations.\n\nStatuses:\n${conf.discordRoles.sort((a, b) => a.minimum_usd_donation - b.minimum_usd_donation).map(({ name, minimum_usd_donation }) => `${name} - min. $${minimum_usd_donation}`).join('\n')} \n\n`,
  INSERT_ADDRESS: "Please insert your donor address (click ... and \"Insert my address\")",
  NOT_FOUND_ADDRESS: "Can't find your address in the Kivach donors database. Please try again.",
  SEND_NICK: "Please send your discord nick (in Obyte server)",
  LAST_NICK: (nick) => `Your previous discord nick was ${nick}. We will remove it.`,
  ALREADY_HAVE_STATUS: "You already have this status.",
  UPDATED: (roleName) => `Your new discord status: ${roleName}`,
  NOT_FOUND_NICK: "No such discord nick (in Obyte server). Please try again.",
  SIGN_MESSAGE: (wallet) => `Please sign this message to prove that you own the address: [${wallet}](sign-message-request: I own the address ${wallet})`,
  SIGN_MESSAGE_ERROR: "Please sign the message to prove that you own the address.",
  ERROR: "Something went wrong. Please try again later.",
}

eventBus.once('headless_wallet_ready', () => {
  headlessWallet.setupChatEventHandlers();

  eventBus.once('connected', async function (ws) {
    network.initWitnessesIfNecessary(ws, start);
  });

  eventBus.on('paired', (from_address) => {
    device.sendMessageToDevice(from_address, 'text', texts.GREETING + texts.INSERT_ADDRESS);
  });

  // a. User send address
  // b. User send signed message
  // c. User send nickname

  // any uncaught error would crash the process (see uncaughtException handler in ocore/network.js)
  eventBus.on('text', (from_address, data) => {
    handleText(from_address, data).catch(e => {
      console.error("Can't handle message", e);
      device.sendMessageToDevice(from_address, 'text', texts.ERROR);
    });
  });

  const handleText = async (from_address, data) => {
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

      if (!arrSignedMessageMatches) return device.sendMessageToDevice(from_address, 'text', texts.SIGN_MESSAGE_ERROR);

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
        const guild = await discordInstance.guilds.fetch(conf.SERVER_ID);

        // user data (from discord api) by nickname
        // search (REST) matches by prefix and doesn't require the GuildMembers intent
        // discord usernames are at most 32 chars, longer queries are rejected by the API
        const matches = nick.length <= 32 ? await guild.members.search({ query: nick, limit: 100 }) : null;
        const member = matches?.find(m => m.user.username.toLowerCase() === nick.toLowerCase());
        const user = member?.user;

        if (user) {
          const lastNickData = await getNickDataByWallet(wallet);

          if (lastNickData) {
            // remove last nick role

            try {
              // null if the user is no longer on the server (10007 - Unknown Member)
              const lastMember = await guild.members.fetch({ user: String(lastNickData.user_id), force: true }).catch(e => {
                if (e.code === 10007) return null;
                throw e;
              });

              if (lastMember) {
                // last user still in discord server

                if (lastMember.id === user.id && lastNickData.role_id === roleId) {
                  return device.sendMessageToDevice(from_address, 'text', texts.ALREADY_HAVE_STATUS);
                } else {
                  device.sendMessageToDevice(from_address, 'text', texts.LAST_NICK(lastNickData.nick_name));

                  const role = await guild.roles.fetch(lastNickData.role_id);

                  if (role) await lastMember.roles.remove(role); // the role may have been deleted on the server

                  await removeDonor(lastNickData.donor);
                }
              }
            } catch (e) {
              console.error("Can't remove role", e);
              return device.sendMessageToDevice(from_address, 'text', texts.ERROR);
            }
          }

          // update role process
          try {
            const role = await guild.roles.fetch(roleId);

            await member.roles.add(role);

            await addDonor(wallet, nick, role.id, user.id, from_address);

            device.sendMessageToDevice(from_address, 'text', texts.UPDATED(role.name));

            await sendToChannel(user.globalName || user.username, role);

          } catch (e) {
            console.log("Can't add role", e);
            device.sendMessageToDevice(from_address, 'text', texts.ERROR);
          }

          delete sessions[from_address];

        } else {
          device.sendMessageToDevice(from_address, 'text', texts.NOT_FOUND_NICK);
        }

      } else {
        device.sendMessageToDevice(from_address, 'text', texts.INSERT_ADDRESS);
      }
    } else {
      device.sendMessageToDevice(from_address, 'text', texts.INSERT_ADDRESS);
    }
  };
});

async function start() {
  await discordInstance.login(conf.BOT_TOKEN);

  await db.create(); // create db if not exists

  setInterval(() => checkAndUpdateStatus().catch(e => console.error("Can't check statuses", e)), CHECK_INTERVAL);
}