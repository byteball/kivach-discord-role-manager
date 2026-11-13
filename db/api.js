const db = require('ocore/db.js');
const conf = require("ocore/conf.js");

async function getNickDataByWallet(wallet) {
  const res = await db.query(`SELECT * FROM ${conf.prefix}_donors WHERE donor = ?`, [wallet]);
  return res[0];
}

async function addDonor(wallet, nick, roleID, userID, deviceAddress) {
  return await db.query(`REPLACE INTO ${conf.prefix}_donors (donor, nick_name, role_id, user_id, device_address) VALUES (?,?,?,?,?)`, [wallet, nick, roleID, userID, deviceAddress]);
}

async function removeDonor(wallet) {
  return await db.query(`DELETE FROM ${conf.prefix}_donors WHERE donor=?`, [wallet]);
}

async function getAllDonors() {
  return await db.query(`SELECT * FROM ${conf.prefix}_donors`);
}

async function updateDonorRole(donorAddress, newRoleId) {
  return await db.query(`UPDATE ${conf.prefix}_donors SET role_id = ? WHERE donor = ?`, [newRoleId, donorAddress]);
}

module.exports = {
  getNickDataByWallet,
  addDonor,
  removeDonor,
  getAllDonors,
  updateDonorRole
}
