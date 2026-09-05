// Razorpay charges the smallest currency unit, so all amounts below are paise.
// Deliberately do not derive these from the USD labels in the shop. Set each
// RAZORPAY_*_PAISE value explicitly for the INR price you want to charge.
function configuredAmount(name) {
  const value = process.env[name];
  if (!/^[1-9]\d*$/.test(value || '')) return null;
  return Number(value);
}

const currency = 'INR';

module.exports = {
  coins_20: { type: 'coins', coins: 20, amount: configuredAmount('RAZORPAY_COINS_20_PAISE'), currency },
  coins_50: { type: 'coins', coins: 50, amount: configuredAmount('RAZORPAY_COINS_50_PAISE'), currency },
  coins_100: { type: 'coins', coins: 100, amount: configuredAmount('RAZORPAY_COINS_100_PAISE'), currency },
  coins_300: { type: 'coins', coins: 300, amount: configuredAmount('RAZORPAY_COINS_300_PAISE'), currency },
  coins_500: { type: 'coins', coins: 500, amount: configuredAmount('RAZORPAY_COINS_500_PAISE'), currency },
  coins_2000: { type: 'coins', coins: 2000, amount: configuredAmount('RAZORPAY_COINS_2000_PAISE'), currency },
  membership_silver: {
    type: 'membership', membership: 'Silver Quill', bonusCoins: 60, frame: 'silver',
    amount: configuredAmount('RAZORPAY_MEMBERSHIP_SILVER_PAISE'), currency
  },
  membership_gold: {
    type: 'membership', membership: 'Golden Tome', bonusCoins: 120, frame: 'gold',
    amount: configuredAmount('RAZORPAY_MEMBERSHIP_GOLD_PAISE'), currency
  },
  membership_obsidian: {
    type: 'membership', membership: 'Obsidian Edition', bonusCoins: 300, frame: 'obsidian',
    amount: configuredAmount('RAZORPAY_MEMBERSHIP_OBSIDIAN_PAISE'), currency
  }
};
