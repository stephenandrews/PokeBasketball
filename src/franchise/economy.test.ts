import { describe, expect, it } from 'vitest';
import { POKEMON, type Mon } from '../data/pokemon';
import {
  LEAGUE, PRACTICE_XP, SEASON_BUDGET, acceptOffer, cashOf, createFranchise, declineOffer, grantPracticeXp, judgeTrade, makeTrade, marketSalary, makeOffers, MAX_OFFERS, aiLeagueTrades, offerValid, tradeValue,
  monOf, nextSeason, payrollOf, retirementChance, runRetirements, salaryOf, setCaptain, sign, teamDef, type Franchise,
} from './league';

function league(): Franchise {
  const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  const teams = [{ name: 'Me', abbr: 'ME', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({
    name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, human: false, leader: t.leader, types: t.types, boost: t.boost,
  }))];
  const rosters: Mon[][] = teams.map(() => []);
  let i = 0;
  for (let r = 0; r < 10; r++) for (let j = 0; j < teams.length; j++) rosters[r % 2 ? teams.length - 1 - j : j].push(pool[i++]);
  return createFranchise(teams, rosters, pool.slice(i));
}

describe('contracts and the season budget', () => {
  it('gives every player a contract and every team cash at creation', () => {
    const f = league();
    for (const p of Object.values(f.players)) {
      expect(p.salary).toBeGreaterThan(0);
      expect(p.years).toBeGreaterThanOrEqual(1);
      expect(p.years).toBeLessThanOrEqual(3);
      expect(p.seasons).toBe(0);
    }
    for (const t of f.teams) expect(t.cash).toBe(SEASON_BUDGET);
  });

  it('salaries follow the rating', () => {
    expect(marketSalary(90)).toBeGreaterThan(marketSalary(70));
    expect(marketSalary(40)).toBe(0.2); // the league minimum
  });

  it('banks the $10M grant minus payroll at each tipoff, and ages everyone a season', () => {
    const f = league();
    f.phase = 'done';
    const payroll = payrollOf(f, f.teams[0]);
    nextSeason(f);
    expect(cashOf(f.teams[0])).toBeCloseTo(Math.max(0, SEASON_BUDGET + SEASON_BUDGET - payroll), 1);
    for (const t of f.teams) for (const u of t.roster) expect(f.players[u].seasons).toBe(1);
  });

  it('re-signs expired contracts at the market rate', () => {
    const f = league();
    const uid = f.teams[0].roster[0];
    f.players[uid].years = 1;
    f.players[uid].salary = 0.4;
    f.phase = 'done';
    nextSeason(f);
    expect(f.players[uid].years).toBe(2);
    expect(f.players[uid].salary).toBe(marketSalary(monOf(f, uid).ovr));
  });
});

describe('signing fees', () => {
  it('charges the first-year salary and refuses what you cannot afford', () => {
    const f = league();
    const release = f.teams[0].roster[9];
    const add = f.freeAgents[0];
    f.teams[0].cash = 0;
    sign(f, release, add);
    expect(f.teams[0].roster).not.toContain(add); // too broke
    f.teams[0].cash = 10;
    sign(f, release, add);
    expect(f.teams[0].roster).toContain(add);
    expect(cashOf(f.teams[0])).toBeCloseTo(10 - salaryOf(f, add), 1);
  });
});

describe('retirement', () => {
  it('kicks in after the fourth season and grows', () => {
    expect(retirementChance(1)).toBe(0);
    expect(retirementChance(3)).toBe(0);
    expect(retirementChance(4)).toBeCloseTo(0.25);
    expect(retirementChance(5)).toBeCloseTo(0.5);
    expect(retirementChance(20)).toBeCloseTo(0.75);
  });

  it('retires sure-thing veterans but never guts a roster', () => {
    const f = league();
    for (const u of f.teams[0].roster) f.players[u].seasons = 30; // 75% each
    runRetirements(f, () => 0); // rng 0: everyone eligible goes
    expect(f.teams[0].roster.length).toBe(8); // capped at two per team
    const gone = Object.values(f.players).filter((p) => p.retiredAt === f.season);
    expect(gone.length).toBeGreaterThan(0);
    expect(f.news.some((n) => n.includes('retires'))).toBe(true);
  });

  it('leaves the young alone', () => {
    const f = league();
    runRetirements(f, () => 0);
    expect(f.teams[0].roster.length).toBe(10);
  });
});

describe('injuries that linger', () => {
  it('rust drags ratings down and frailty rides along', () => {
    const f = league();
    const uid = f.teams[0].roster[0];
    const fresh = monOf(f, uid).ovr;
    f.players[uid].rust = 3;
    f.players[uid].hurts = 2;
    const rusty = monOf(f, uid);
    expect(rusty.ovr).toBeLessThan(fresh);
    expect(rusty.frail).toBe(2);
    f.players[uid].rust = 0;
    expect(monOf(f, uid).ovr).toBe(fresh); // rust wears off completely
  });
});

describe('captains', () => {
  it('names a captain and bakes +1 into the game boost', () => {
    const f = league();
    const uid = f.teams[0].roster[0];
    const before = teamDef(f, 0, true).def.boost ?? 0;
    setCaptain(f, uid);
    expect(f.teams[0].captain).toBe(uid);
    expect(teamDef(f, 0, true).def.boost).toBe(before + 1);
    const capt = [...teamDef(f, 0, true).uidOf.entries()].find(([, u]) => u === uid)?.[0];
    expect(capt?.capt).toBe(true);
    setCaptain(f, uid); // naming them again takes the C away
    expect(f.teams[0].captain).toBeUndefined();
  });
});

describe('trades under the cap', () => {
  const worstOf = (f: Franchise, t: number) => [...f.teams[t].roster].sort((a, b) => monOf(f, a).ovr - monOf(f, b).ovr);
  const bestOf = (f: Franchise, t: number) => [...f.teams[t].roster].sort((a, b) => monOf(f, b).ovr - monOf(f, a).ovr);

  it('takes uneven trades: two of mine for one of theirs', () => {
    const f = league();
    const give = bestOf(f, 0).slice(0, 2); // my two best for their best: they'll take that
    const get = [bestOf(f, 1)[0]];
    expect(judgeTrade(f, 1, give, get).ok).toBe(true);
    expect(makeTrade(f, 1, give, get)).toBe(true);
    expect(f.teams[0].roster).toHaveLength(9);
    expect(f.teams[1].roster).toHaveLength(11);
    expect(f.teams[0].roster).toContain(get[0]);
  });

  it('blocks a trade that would bust the cap', () => {
    const f = league();
    const get = bestOf(f, 1).slice(0, 2);
    for (const u of get) f.players[u].salary = 8; // two $8M contracts coming in
    const v = judgeTrade(f, 1, worstOf(f, 0).slice(0, 1), get);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('cap');
  });

  it('a GM pays real value for cap relief: a lesser player buys out a bad contract', () => {
    const f = league();
    for (const u of f.teams[0].roster) f.players[u].salary = 0.3; // plenty of cap room on my side
    const them = f.teams[1];
    const mine = worstOf(f, 0)[0];
    f.players[mine].bonus = { spd: -10, sht: -10, ins: -10, pas: -10, def: -10, blk: -10, reb: -10, hnd: -10 }; // clearly the lesser player
    const junk = worstOf(f, 1)[0];
    f.players[junk].salary = 0.3;
    expect(judgeTrade(f, 1, [mine], [junk]).ok).toBe(false); // even salaries: a worse player is refused
    // The same player on a deal bad enough that shedding it covers the value gap: now they say yes.
    const gap = tradeValue(f, junk, them) * 1.05 - tradeValue(f, mine, them);
    f.players[junk].salary = Math.round((0.3 + gap / 12 + 0.5) * 10) / 10;
    expect(judgeTrade(f, 1, [mine], [junk]).ok).toBe(true);
  });

  it('keeps rosters inside the bounds', () => {
    const f = league();
    const give = worstOf(f, 0).slice(0, 3); // 10 -> 7 would fall below the minimum
    expect(judgeTrade(f, 1, give, []).ok).toBe(false);
    expect(judgeTrade(f, 1, give, []).reason).toContain('between');
  });

  it('cash plays no part in trades anymore', () => {
    const f = league();
    const give = bestOf(f, 0).slice(0, 2);
    const get = [bestOf(f, 1)[0]];
    const before = [cashOf(f.teams[0]), cashOf(f.teams[1])];
    expect(makeTrade(f, 1, give, get)).toBe(true);
    expect([cashOf(f.teams[0]), cashOf(f.teams[1])]).toEqual(before);
  });
});

describe('AI trade offers', () => {
  it('every GM tries every week and the inbox holds several fair offers', () => {
    const f = league();
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    makeOffers(f, rng);
    const offers = f.offers ?? [];
    expect(offers.length).toBeGreaterThanOrEqual(2);
    expect(offers.length).toBeLessThanOrEqual(MAX_OFFERS);
    for (const o of offers) {
      expect(f.teams[0].roster).toContain(o.get[0]);
      for (const u of o.give) expect(f.teams[o.team].roster).toContain(u);
      // At least fair for the user in raw value.
      const got = o.give.reduce((a, u) => a + tradeValue(f, u), 0);
      const gave = o.get.reduce((a, u) => a + tradeValue(f, u), 0);
      expect(got).toBeGreaterThanOrEqual(gave * 0.92); // near-even calls go out; you can always decline
      expect(offerValid(f, o)).toBe(true);
    }
  });

  it('a fresh franchise already has offers waiting', () => {
    const f = league();
    expect((f.offers ?? []).length).toBeGreaterThan(0);
  });

  it('accepting one swaps the players, pays no cash, and drops offers the deal broke', () => {
    const f = league();
    let seed = 7;
    makeOffers(f, () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
    const o = f.offers![0];
    const { give, get, team } = o;
    const myCash = cashOf(f.teams[0]);
    expect(acceptOffer(f, 0)).toBe(true);
    for (const u of give) expect(f.teams[0].roster).toContain(u);
    expect(f.teams[team].roster).toContain(get[0]);
    expect(cashOf(f.teams[0])).toBe(myCash);
    for (const left of f.offers ?? []) expect(offerValid(f, left)).toBe(true);
  });

  it('declining removes just that offer', () => {
    const f = league();
    let seed = 7;
    makeOffers(f, () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
    const n = f.offers!.length;
    declineOffer(f, 0);
    expect(f.offers).toHaveLength(n - 1);
  });
});

describe('the rest of the league trades too', () => {
  it('AI teams swap players under the cap, and the user is never involved', () => {
    const f = league();
    const mine = [...f.teams[0].roster];
    const before = f.teams.slice(1).map((t) => [...t.roster]);
    let seed = 1;
    const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let w = 0; w < 6; w++) aiLeagueTrades(f, rng); // several weeks of phone calls
    expect(f.teams[0].roster).toEqual(mine);
    const after = f.teams.slice(1).map((t) => [...t.roster]);
    expect(after.some((r, i) => r.join() !== before[i].join())).toBe(true); // somebody dealt
    for (const t of f.teams) expect(t.roster.length).toBe(10); // one-for-one swaps only
    expect(f.news.some((n) => n.startsWith('Trade!'))).toBe(true);
  });
});

describe('practice', () => {
  it('gives the whole roster a little XP', () => {
    const f = league();
    const xp = f.teams[0].roster.map((u) => f.players[u].xp);
    grantPracticeXp(f);
    f.teams[0].roster.forEach((u, i) => {
      expect(f.players[u].xp).toBe(xp[i] + PRACTICE_XP);
    });
  });
});
