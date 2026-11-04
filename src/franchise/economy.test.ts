import { describe, expect, it } from 'vitest';
import { POKEMON, type Mon } from '../data/pokemon';
import {
  LEAGUE, PRACTICE_XP, SEASON_BUDGET, acceptOffer, cashOf, createFranchise, declineOffer, grantPracticeXp, judgeTrade, makeTrade, marketSalary, maybeAiOffer,
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
    expect(marketSalary(40)).toBe(0.3); // the league minimum
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

describe('trades with cash', () => {
  it('cash sweetens a trade the GM would otherwise refuse', () => {
    const f = league();
    const them = f.teams[1];
    const mine = [...f.teams[0].roster].sort((a, b) => monOf(f, a).ovr - monOf(f, b).ovr)[0];
    const theirs = [...them.roster].sort((a, b) => monOf(f, b).ovr - monOf(f, a).ovr)[0];
    const dry = judgeTrade(f, 1, [mine], [theirs], 0);
    expect(dry.ok).toBe(false); // my worst for their best: no chance
    f.teams[0].cash = 1000;
    const sweet = judgeTrade(f, 1, [mine], [theirs], 1000);
    expect(sweet.ok).toBe(true);
    expect(makeTrade(f, 1, [mine], [theirs], 1000)).toBe(true);
    expect(f.teams[0].roster).toContain(theirs);
    expect(cashOf(f.teams[0])).toBe(0);
    expect(cashOf(them)).toBe(1000 + SEASON_BUDGET);
  });

  it('refuses cash you do not have', () => {
    const f = league();
    expect(judgeTrade(f, 1, [f.teams[0].roster[0]], [f.teams[1].roster[0]], 99).ok).toBe(false);
  });
});

describe('AI trade offers', () => {
  it('a rival GM calls with an offer that is at least fair', () => {
    const f = league();
    maybeAiOffer(f, () => 0.1); // rng: passes the 40% gate, picks team 1 and target 0
    const o = f.offers?.[0];
    expect(o).toBeTruthy();
    expect(f.teams[0].roster).toContain(o!.get[0]);
    expect(f.teams[o!.team].roster).toContain(o!.give[0]);
  });

  it('accepting swaps the players and pays the cash', () => {
    const f = league();
    maybeAiOffer(f, () => 0.1);
    const o = f.offers![0];
    const { give, get, cash, team } = o;
    const myCash = cashOf(f.teams[0]);
    expect(acceptOffer(f)).toBe(true);
    expect(f.teams[0].roster).toContain(give[0]);
    expect(f.teams[team].roster).toContain(get[0]);
    expect(cashOf(f.teams[0])).toBeCloseTo(myCash + cash, 1);
    expect(f.offers).toEqual([]);
  });

  it('declining just clears it', () => {
    const f = league();
    maybeAiOffer(f, () => 0.1);
    declineOffer(f);
    expect(f.offers).toEqual([]);
    expect(acceptOffer(f)).toBe(false);
  });

  it('most weeks nobody calls', () => {
    const f = league();
    maybeAiOffer(f, () => 0.9);
    expect(f.offers ?? []).toEqual([]);
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
