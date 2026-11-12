// The graduation strategy parameters, read from the environment in ONE place.
//
// bots/graduation-sniper/graduation.mjs trades with them; the shadow lab's variant J ("live
// config") must paper-trade EXACTLY the same band and exits, so both read this function instead of
// each keeping its own copy of the env chain and the defaults.
//
// The chain is the bot's historical one: the short names MIN_FILL / MAX_FILL / MIN_HOLDERS win over
// the GRAD_* names. numOr fails loudly (with the variable name) on a non-numeric value.
import { numOr } from "./config.mjs";

export function readGradStrategy(env = process.env) {
  return {
    minFillPct: numOr(env.MIN_FILL || env.GRAD_MIN_FILL_PCT, 92, "MIN_FILL/GRAD_MIN_FILL_PCT"),
    maxFillPct: numOr(env.MAX_FILL || env.GRAD_MAX_FILL_PCT, 97, "MAX_FILL/GRAD_MAX_FILL_PCT"),
    minHolders: numOr(env.MIN_HOLDERS || env.GRAD_MIN_HOLDERS, 7, "MIN_HOLDERS/GRAD_MIN_HOLDERS"),
    takeProfit: numOr(env.GRAD_TAKE_PROFIT, 1.5, "GRAD_TAKE_PROFIT"),
    stopLoss: numOr(env.GRAD_STOP_LOSS, 0.7, "GRAD_STOP_LOSS"),
    timeoutSec: numOr(env.GRAD_TIMEOUT_SEC, 300, "GRAD_TIMEOUT_SEC"),
  };
}
