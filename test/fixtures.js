'use strict';
// A fake WoW install: a beta flavor with two characters and a live flavor where the new
// character has logged in once, with SavedVariables in the shapes real addons write.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ACCOUNT = '123456789#1';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
}

const BETA_SV = {
  // AceDB r39 on Forever: char key "First Surname", realm key = ruleset
  'FirstToForever.lua': `
FirstToForever_DB = {
	["profileKeys"] = {
		["Alice Smith"] = "Alice Smith",
		["Bob Jones"] = "Default",
	},
	["global"] = {
		["version"] = "2.3.1",
	},
	["factionrealm"] = {
		["Alliance - PvE"] = {
			["leaderboard"] = {
				{
					["players"] = {
						{
							["name"] = "Alice Smith",
							["level"] = 23,
						}, -- [1]
						{
							["name"] = "Zed Alicesmith",
							["level"] = 21,
						}, -- [2]
					},
				}, -- [1]
			},
		},
	},
	["factionrealmregion"] = {
		["Alliance - PvE - US"] = {
			["seen"] = true,
		},
	},
	["realm"] = {
		["PvE"] = {
			["note"] = "PvE stays PvE inside values",
		},
	},
	["char"] = {
		["Alice Smith"] = {
			["minimap"] = {
				["hide"] = false,
				["minimapPos"] = 212.5,
			},
		},
		["Bob Jones"] = {
			["minimap"] = {
				["hide"] = true,
			},
		},
	},
	["profiles"] = {
		["Alice Smith"] = {
			["announcer"] = {
				["volume"] = 0.75,
				["channel"] = "Master",
			},
			["greeting"] = "Hello from Alice Smith, not Alice Smithers",
		},
		["Default"] = {
			["announcer"] = {
				["volume"] = 1,
			},
		},
	},
}
`,
  // an addon on an older AceDB: "First - Realm" keys
  'Details.lua': `
_detalhes_global = {
	["got_first_run"] = true,
	["tutorial"] = {
		["logons"] = 42,
	},
}
_detalhes_database = nil
DetailsDB = {
	["profileKeys"] = {
		["Alice - Forever Beta"] = "Alice - Forever Beta",
		["Bob - Forever Beta"] = "Default",
	},
	["profiles"] = {
		["Alice - Forever Beta"] = {
			["row_height"] = 16,
			["font"] = "Friz Quadrata TT",
		},
	},
	["realm"] = {
		["Forever Beta"] = {
			["count"] = 2,
		},
	},
}
`,
  // realm -> character nesting and GUID keys, with odd but valid syntax
  'Bagthing.lua': `-- written by hand
BagthingDB = {
  ["Forever Beta"] = {
    ["Alice Smith"] = { gold = 12345, guid = "Player-70-0A1B2C3D", class = 'MAGE' },
    ["Bob Jones"] = { gold = 1; guid = "Player-70-0D0D0D0D" },
  },
  guids = {
    ["Player-70-0A1B2C3D"] = "Alice Smith",
    ["Player-70-0D0D0D0D"] = "Bob Jones",
  },
  huge = math.huge,
  inf = 1/0,
  hex = 0x1F,
  neg = -3.5e2,
  escapes = "tab\\there \\"quoted\\" back\\\\slash \\226\\128\\148 nl\\
done",
  long = [[raw [text] here]],
  [1] = "first",
  [2] = "second",
  [true] = "boolean key",
  ["1"] = "string one",
}
`,
};

function makeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpp-'));
  const wowRoot = path.join(root, 'World of Warcraft');
  const beta = path.join(wowRoot, '_classic_beta_');
  const live = path.join(wowRoot, '_forever_');

  write(path.join(beta, 'Wow.exe'), 'x');
  write(path.join(beta, 'WTF', 'Config.wtf'), 'SET portal "test"\r\nSET accountName "BETA"\r\nSET gxWindow "1"\r\nSET Sound_MasterVolume "0.4"\r\nSET cameraDistanceMaxZoomFactor "2.6"\r\nSET synchronizeSettings "1"\r\n');
  const acct = path.join(beta, 'WTF', 'Account', ACCOUNT);
  write(path.join(acct, 'bindings-cache.wtf'), 'bind 1 ACTIONBUTTON1\n');
  write(path.join(acct, 'config-cache.wtf'), 'SET autoLootDefault "1"\r\nSET interactOnLeftClick "0"\r\n');
  write(path.join(acct, 'macros-cache.txt'), 'VER 3 0000000000000001 "Hi" "INV_Misc_QuestionMark"\n/say I am Alice Smith\nEND\n');
  write(path.join(acct, 'cache.md5'), 'abc');
  for (const [f, c] of Object.entries(BETA_SV)) write(path.join(acct, 'SavedVariables', f), c);
  write(path.join(acct, 'SavedVariables', 'FirstToForever.lua.bak'), 'old');

  const alice = path.join(acct, '70', 'Alice-Smith');
  write(path.join(alice, 'AddOns.txt'), 'FirstToForever: enabled\nDetails: enabled\nBagthing: disabled\n');
  write(path.join(alice, 'macros-cache.txt'), 'VER 3 0100000000000001 "Me" "INV_Misc_QuestionMark"\n/tar Alice Smith\nEND\n');
  write(path.join(alice, 'layout-local.txt'), 'layout\n');
  write(path.join(alice, 'config-cache.wtf'), 'SET lockActionBars "1"\n');
  write(path.join(alice, 'SavedVariables', 'FirstToForever.lua'), `
FirstToForever_CharDB = {
	["me"] = "Alice Smith",
	["first"] = "Alice",
	["guid"] = "Player-70-0A1B2C3D",
}
`);
  write(path.join(acct, '70', 'Bob-Jones', 'AddOns.txt'), 'FirstToForever: enabled\n');

  for (const [name, title, ver] of [['FirstToForever', '|cffffd24aFirst|r to |cffff9a3cForever|r', '2.3.1'], ['Details', 'Details! Damage Meter', '1.0'], ['Bagthing', 'Bagthing', '3.0']]) {
    write(path.join(beta, 'Interface', 'AddOns', name, `${name}.toc`), `## Interface: 16001\n## Title: ${title}\n## Version: ${ver}\n## SavedVariables: x\n\nmain.lua\n`);
    write(path.join(beta, 'Interface', 'AddOns', name, 'main.lua'), `-- ${name} beta`);
  }

  // live: Carol Hale logged in once on realm folder 12 (with FirstToForever installed)
  write(path.join(live, 'Wow.exe'), 'x');
  write(path.join(live, 'WTF', 'Config.wtf'), 'SET portal "us"\r\nSET accountName "LIVE"\r\nSET synchronizeSettings "1"\r\n');
  const lacct = path.join(live, 'WTF', 'Account', ACCOUNT);
  write(path.join(lacct, 'SavedVariables', 'FirstToForever.lua'), `
FirstToForever_DB = {
	["profileKeys"] = {
		["Carol Hale"] = "Default",
		["Dan Fox"] = "Dan Fox",
	},
	["profiles"] = {
		["Dan Fox"] = {
			["announcer"] = {
				["volume"] = 0.1,
			},
		},
	},
	["char"] = {
		["Carol Hale"] = {
			["guid"] = "Player-12-0F0F0F0F",
		},
	},
}
`);
  write(path.join(lacct, '12', 'Carol-Hale', 'AddOns.txt'), 'FirstToForever: enabled\n');
  write(path.join(lacct, '12', 'Carol-Hale', 'config-cache.wtf'), 'SET lockActionBars "0"\r\nSET showTargetOfTarget "1"\r\n');
  write(path.join(lacct, 'config-cache.wtf'), 'SET autoLootDefault "0"\r\nSET liveOnly "7"\r\n');
  write(path.join(lacct, '12', 'Dan-Fox', 'AddOns.txt'), 'FirstToForever: enabled\n');
  write(path.join(live, 'Interface', 'AddOns', 'FirstToForever', 'FirstToForever.toc'), '## Interface: 16001\n## Title: First to Forever\n## Version: 2.4.0\n');
  write(path.join(live, 'Interface', 'AddOns', 'FirstToForever', 'main.lua'), '-- live 2.4.0');

  const dataDir = path.join(root, 'data');
  return { root, wowRoot, beta, live, dataDir, account: ACCOUNT };
}

module.exports = { makeInstall, BETA_SV, ACCOUNT };
