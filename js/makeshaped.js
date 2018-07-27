'use strict';

const ShapedConverter = (function () {
	const SOURCE_INFO = {
		bestiary: {
			dir: 'data/bestiary/',
			inputProp: 'monsterInput'
		},
		spells: {
			dir: 'data/spells/',
			inputProp: 'spellInput'
		}
	};

	let inputPromise;

	function getInputs () {
		if (!inputPromise) {
			const sources = [
				{url: `${SOURCE_INFO.bestiary.dir}index.json`},
				{url: `${SOURCE_INFO.spells.dir}index.json`}
			];

			inputPromise = DataUtil.multiLoadJSON(sources, null, data => {
				SOURCE_INFO.bestiary.fileIndex = data[0];
				SOURCE_INFO.spells.fileIndex = data[1];

				return Object.values(SOURCE_INFO).reduce((inputs, sourceType) => {
					Object.keys(sourceType.fileIndex).forEach(key => {
						inputs[key] = inputs[key] || {
							name: Parser.SOURCE_JSON_TO_FULL[key],
							key,
							dependencies: key === SRC_PHB ? ['SRD'] : ['Player\'s Handbook'],
							classes: {}
						};
						inputs[key][sourceType.inputProp] = `${sourceType.dir}${sourceType.fileIndex[key]}`;
					});
					return inputs;
				}, {});
			});
		}
		return inputPromise;
	}

	function generateShapedJS (sourceKeys) {
		return getInputs().then(inputs => {
			const sources = [
				{url: `${SOURCE_INFO.bestiary.dir}srd-monsters.json`},
				{url: `${SOURCE_INFO.spells.dir}srd-spells.json`},
				{url: `${SOURCE_INFO.spells.dir}roll20.json`},
				{url: `${SOURCE_INFO.bestiary.dir}meta.json`}
			];

			sourceKeys.forEach(sourceKey => {
				const input = inputs[sourceKey];
				if (isString(input.monsterInput)) {
					sources.push({
						url: input.monsterInput,
						key: sourceKey
					})
				}
				if (isString(input.spellInput)) {
					sources.push({
						url: input.spellInput,
						key: sourceKey
					})
				}
			});

			let jsonPromise;
			if (sources.length > 4) {
				jsonPromise = DataUtil.multiLoadJSON(sources, null, (data) => {
					const srdMonsters = data[0].monsters;
					const srdSpells = data[1].spells;
					const srdSpellRenames = data[1].spellRenames;
					const additionalSpellData = {};
					data[2].spell.forEach(spell => additionalSpellData[spell.name] = Object.assign(spell.data, spell.shapedData));
					const legendaryGroup = {};
					data[3].legendaryGroup.forEach(monsterDetails => legendaryGroup[monsterDetails.name] = monsterDetails);

					data.slice(4).forEach((dataItem, index) => {
						const key = sources[index + 4].key;
						if (dataItem.spell) {
							inputs[key].spellInput = dataItem.spell;
						}
						if (dataItem.monster) {
							inputs[key].monsterInput = dataItem.monster;
						}
					});
					convertData(inputs, srdMonsters, srdSpells, srdSpellRenames, additionalSpellData, legendaryGroup);
				});
			} else {
				jsonPromise = Promise.resolve();
			}

			return jsonPromise.then(() => {
				const lines = sourceKeys
					.map(key => {
						return `ShapedScripts.addEntities(${JSON.stringify(inputs[key].converted, serialiseFixer)})`;
					}).join('\n');
				return `on('ready', function() {\n${lines}\n});`
			})
		});
	}

	function makeSpellList (spellArray) {
		return `${spellArray.map(fixLinks).join(', ')}`;
	}

	const INNATE_SPELLCASTING_RECHARGES = {
		daily: 'day',
		rest: 'rest',
		weekly: 'week'
	};

	function innateSpellProc (spellcasting) {
		return Object.keys(spellcasting)
			.filter(k => ![
				'headerEntries',
				'headerWill',
				'name',
				'footerEntries'
			].includes(k))
			.map(useInfo => {
				const spellDetails = spellcasting[useInfo];
				if (useInfo === 'will') {
					return `At will: ${makeSpellList(spellDetails)}`;
				}
				if (useInfo === 'constant') {
					return `Constant: ${makeSpellList(spellDetails)}`;
				}
				if (INNATE_SPELLCASTING_RECHARGES[useInfo]) {
					const rechargeString = INNATE_SPELLCASTING_RECHARGES[useInfo];
					return Object.keys(spellDetails).map(usesPerDay => {
						const spellList = spellDetails[usesPerDay];
						const howMany = usesPerDay.slice(0, 1);
						const each = usesPerDay.endsWith('e') && spellList.length > 1;
						return `${howMany}/${rechargeString}${each ? ' each' : ''}: ${makeSpellList(spellList)}`;
					}).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
				} else if (useInfo === 'spells') {
					return processLeveledSpells(spellDetails);
				} else {
					throw new Error('Unrecognised spellUseInfo ' + useInfo);
				}
			})
			.reduce(flattener, []);
	}

	function processLeveledSpells (spellObj) {
		return Object.keys(spellObj).map(levelString => {
			const level = parseInt(levelString, 10);
			const levelInfo = spellObj[level];
			return `${Parser.spLevelToFullLevelText(level)} (${slotString(levelInfo.slots)}): ${makeSpellList(levelInfo.spells)}`;
		});
	}

	function normalSpellProc (spellcasting) {
		return processLeveledSpells(spellcasting.spells);
	}

	function slotString (slots) {
		switch (slots) {
			case undefined:
				return 'at will';
			case 1:
				return '1 slot';
			default:
				return `${slots} slots`;
		}
	}

	function processChallenge (cr) {
		if (cr === 'Unknown') {
			return 0;
		}
		const match = cr.match(/(\d+)(?:\s?\/\s?(\d+))?/);
		if (!match) {
			throw new Error('Bad CR ' + cr);
		}
		if (match[2]) {
			return parseInt(match[1], 10) / parseInt(match[2], 10);
		}
		return parseInt(match[1], 10);
	}

	function fixLinks (string) {
		return string
			.replace(/{@filter ([^|]+)[^}]+}/g, '$1')
			.replace(/{@hit (\d+)}/g, '+$1')
			.replace(/{@chance (\d+)[^}]+}/g, '$1 percent')
			.replace(/{@\w+ ((?:[^|}]+\|?){0,3})}/g, (m, p1) => {
				const parts = p1.split('|');
				return parts.length === 3 ? parts[2] : parts[0];
			})
			.replace(/(d\d+)([+-])(\d)/g, '$1 $2 $3');
	}

	function makeTraitAction (name) {
		const nameMatch = name.match(/([^(]+)(?:\(([^)]+)\))?/);
		if (nameMatch && nameMatch[2]) {
			const rechargeMatch = nameMatch[2].match(/^(?:(.*), )?(\d(?: minute[s]?)?\/(?:Day|Turn|Rest|Hour|Week|Long Rest|Short Rest)|Recharge \d(?:\u20136)?|Recharge[s]? [^),]+)(?:, ([^)]+))?$/i);
			if (rechargeMatch) {
				let newName = nameMatch[1].trim();
				const condition = rechargeMatch[1] || rechargeMatch[3];
				if (condition) {
					newName += ` (${condition})`
				}
				return {
					name: newName,
					text: '',
					recharge: rechargeMatch[2]
				};
			}
		}

		return {
			name
		};
	}

	function processStatblockSection (section) {
		return section.map(trait => {
			const newTrait = makeTraitAction(trait.name);
			if (SPECIAL_TRAITS_ACTIONS[newTrait.name]) {
				return SPECIAL_TRAITS_ACTIONS[newTrait.name](newTrait, trait.entries);
			}

			const expandedList = trait.entries.map(entry => {
				if (isObject(entry)) {
					if (entry.items) {
						if (isObject(entry.items[0])) {
							return entry.items.map(item => ({
								name: item.name.replace(/^([^.]+)\.$/, '$1'),
								text: fixLinks(item.entry)
							}));
						} else {
							return entry.items.map(item => `• ${fixLinks(item)}`).join('\n');
						}
					} else if (entry.entries) {
						const joiner = entry.type === 'inline' ? '' : '\n';
						return entry.entries.map(subEntry => isString(subEntry) ? subEntry : subEntry.text).join(joiner);
					}
				} else {
					return fixLinks(entry);
				}
			}).reduce(flattener, []);

			newTrait.text = expandedList.filter(isString).join('\n');
			return [newTrait].concat(expandedList.filter(isObject));
		}).reduce(flattener, []);
	}

	function processSpecialList (action, entries) {
		action.text = fixLinks(entries[0]);
		return entries.slice(1).reduce((result, entry) => {
			const match = entry.match(/^(?:\d+\. )?([A-Z][a-z]+(?: [A-Z][a-z]+)*). (.*)$/);
			if (match) {
				result.push({
					name: match[1],
					text: fixLinks(match[2])
				});
			} else {
				result.last().text = result.last().text + '\n' + entry;
			}
			return result;
		}, [action]);
	}

	const SPECIAL_TRAITS_ACTIONS = {
		Roar: processSpecialList,
		'Eye Rays': processSpecialList,
		'Eye Ray': processSpecialList,
		'Gaze': processSpecialList,
		'Call the Blood': processSpecialList
	};

	function processHP (monster, output) {
		if (monster.hp.special) {
			const match = monster.hp.special.match(/^(\d+(?:\s\(\d+d\d+(?:[+-]\d+)\)))(.*)/);
			if (match) {
				output.HP = match[1];
			} else {
				output.HP = 0;
			}
		} else {
			output.HP = `${monster.hp.average} (${monster.hp.formula.replace(/(\d)([+-])(\d)/, '$1 $2 $3')})`;
		}
	}

	function processAC (ac) {
		function appendToList (string, newItem) {
			return `${string}${string.length ? ', ' : ''}${newItem}`;
		}

		return ac.reduce((acString, acEntry) => {
			if (isNumber(acEntry)) {
				return appendToList(acString, acEntry);
			}

			if (acEntry.condition && acEntry.braces) {
				return `${acString} (${acEntry.ac} ${fixLinks(acEntry.condition)})`;
			}

			let entryString = `${acEntry.ac}`;
			if (acEntry.from) {
				entryString += ` (${acEntry.from.map(fixLinks).join(', ')})`;
			}
			if (acEntry.condition) {
				entryString += ` ${fixLinks(acEntry.condition)}`;
			}

			return appendToList(acString, entryString);
		}, '');
	}

	function processSkills (monster, output) {
		output.skills = Object.keys(monster.skill)
			.filter(name => name !== 'other')
			.map(name => `${name.toTitleCase()} ${monster.skill[name]}`)
			.join(', ');

		if (monster.skill.other) {
			const additionalSkills = objMap(monster.skill.other[0].oneOf, (val, name) => `${name.toTitleCase()} ${val}`).join(', ');
			(monster.trait = monster.trait || []).push({
				name: 'Additional Skill Proficiencies',
				entries: [
					`The ${monster.name} also has one of the following skill proficiencies: ${additionalSkills}`
				]
			});
		}
	}

	function processMonster (monster, legendaryGroup) {
		const output = {};
		output.name = monster.name;
		output.size = Parser.sizeAbvToFull(monster.size);
		output.type = Parser.monTypeToFullObj(monster.type).asText.replace(/^[a-z]/, (char) => char.toLocaleUpperCase());
		output.alignment = Parser.alignmentListToFull(monster.alignment).toLowerCase();
		output.AC = processAC(monster.ac);
		processHP(monster, output);
		output.speed = Parser.getSpeedString(monster);
		output.strength = monster.str;
		output.dexterity = monster.dex;
		output.constitution = monster.con;
		output.intelligence = monster.int;
		output.wisdom = monster.wis;
		output.charisma = monster.cha;
		if (monster.save) {
			output.savingThrows = objMap(monster.save, (saveVal, saveName) => `${saveName.toTitleCase()} ${saveVal}`).join(', ');
		}
		if (monster.skill) {
			processSkills(monster, output);
		}
		if (monster.vulnerable) {
			output.damageVulnerabilities = Parser.monImmResToFull(monster.vulnerable);
		}
		if (monster.resist) {
			output.damageResistances = Parser.monImmResToFull(monster.resist);
		}
		if (monster.immune) {
			output.damageImmunities = Parser.monImmResToFull(monster.immune);
		}
		if (monster.conditionImmune) {
			output.conditionImmunities = Parser.monCondImmToFull(monster.conditionImmune);
		}
		output.senses = monster.senses;
		output.languages = monster.languages;
		output.challenge = processChallenge(monster.cr.cr || monster.cr);

		const traits = [];
		const actions = [];
		const reactions = [];

		if (monster.trait) {
			traits.push.apply(traits, processStatblockSection(monster.trait));
		}
		if (monster.spellcasting) {
			monster.spellcasting.forEach(spellcasting => {
				const spellProc = spellcasting.name.startsWith('Innate') ? innateSpellProc : normalSpellProc;
				const spellLines = spellProc(spellcasting);
				spellLines.unshift(fixLinks(spellcasting.headerEntries[0]));
				if (spellcasting.footerEntries) {
					spellLines.push.apply(spellLines, spellcasting.footerEntries);
				}
				const trait = makeTraitAction(spellcasting.name);
				trait.text = spellLines.join('\n');

				traits.push(trait);
			});
		}

		if (monster.action) {
			actions.push.apply(actions, processStatblockSection(monster.action));
		}
		if (monster.reaction) {
			reactions.push.apply(reactions, processStatblockSection(monster.reaction));
		}

		function addVariant (name, text, output, forceActions) {
			const newTraitAction = makeTraitAction(name);
			newTraitAction.name = 'Variant: ' + newTraitAction.name;
			const isAttack = text.match(/{@hit|Attack:/);
			newTraitAction.text = fixLinks(text);
			if ((newTraitAction.recharge && !text.match(/bonus action/)) || forceActions || isAttack) {
				actions.push(newTraitAction);
			} else {
				traits.push(newTraitAction);
			}
		}

		function entryStringifier (entry, omitName) {
			if (isString(entry)) {
				return entry;
			}
			const entryText = `${entry.entries.map(subEntry => entryStringifier(subEntry)).join('\n')}`;
			return omitName ? entryText : `${entry.name}. ${entryText}`;
		}

		if (monster.variant && monster.name !== 'Shadow Mastiff') {
			monster.variant.forEach(variant => {
				const baseName = variant.name;
				if (variant.entries.every(entry => isString(entry) || entry.type !== 'entries')) {
					const text = variant.entries.map(entry => {
						if (isString(entry)) {
							return entry;
						}
						return entry.items.map(item => `${item.name} ${item.entry}`).join('\n');
					}).join('\n');
					addVariant(baseName, text, output);
				} else if (variant.entries.find(entry => entry.type === 'entries')) {
					let explicitlyActions = false;

					variant.entries.forEach(entry => {
						if (isObject(entry)) {
							addVariant(entry.name || baseName, entryStringifier(entry, true), output, explicitlyActions);
						} else {
							explicitlyActions = !!entry.match(/action options?[.:]/);
						}
					});
				}
			});
		}

		if (traits.length) {
			output.traits = traits;
		}

		if (actions.length) {
			output.actions = actions;
		}

		if (reactions.length) {
			output.reactions = reactions;
		}

		if (monster.legendary) {
			output.legendaryPoints = monster.legendaryActions || 3;
			output.legendaryActions = monster.legendary.map(legendary => {
				if (!legendary.name) {
					return null;
				}
				const result = {};
				const nameMatch = legendary.name.match(/([^(]+)(?:\s?\((?:Costs )?(\d(?:[-\u2013]\d)?) [aA]ctions(?:, ([^)]+))?\))?/);
				if (nameMatch && nameMatch[2]) {
					result.name = nameMatch[1].trim() + (nameMatch[3] ? ` (${nameMatch[3]})` : '');
					result.text = '';
					result.cost = parseInt(nameMatch[2], 10);
				} else {
					result.name = legendary.name;
					result.text = '';
					result.cost = 1;
				}
				result.text = fixLinks(legendary.entries.join('\n'));
				return result;
			}).filter(l => !!l);
		}

		if (legendaryGroup[monster.legendaryGroup]) {
			const lairs = legendaryGroup[monster.legendaryGroup].lairActions;
			if (lairs) {
				if (lairs.every(isString)) {
					output.lairActions = lairs.map(fixLinks);
				} else {
					output.lairActions = lairs.filter(isObject)[0].items.map(fixLinks);
				}
			}
			if (legendaryGroup[monster.legendaryGroup].regionalEffects) {
				output.regionalEffects = legendaryGroup[monster.legendaryGroup].regionalEffects.filter(isObject)[0].items.map(fixLinks);
				output.regionalEffectsFade = fixLinks(legendaryGroup[monster.legendaryGroup].regionalEffects.filter(isString).last());
			}
		}

		if (monster.environment && monster.environment.length > 0) {
			output.environments = monster.environment.sort((a, b) => a.localeCompare(b)).map(env => env.toTitleCase());
		}

		return output;
	}

	function padInteger (num) {
		if (num < 10 && num >= 0) {
			return `0${num}`;
		}
		return `${num}`;
	}

	function processSpellEntries (entries, newSpell) {
		function cellProc (cell) {
			if (isString(cell)) {
				return cell;
			} else if (cell.roll) {
				return cell.roll.exact || `${padInteger(cell.roll.min)}\\u2013${padInteger(cell.roll.max)}`;
			}
		}

		function entryMapper (entry) {
			if (isString(entry)) {
				return entry;
			} else if (entry.type === 'table') {
				const rows = [entry.colLabels];
				rows.push.apply(rows, entry.rows);

				const formattedRows = rows.map(row => `| ${row.map(cellProc).join(' | ')} |`);
				const divider = `|${entry.colStyles.map(style => {
					if (style.includes('text-align-center')) {
						return ':----:';
					} else if (style.includes('text-align-right')) {
						return '----:';
					}
					return ':----';
				}).join('|')}|`;
				formattedRows.splice(1, 0, divider);

				const title = entry.caption ? `##### ${entry.caption}\n` : '';
				return `${title}${formattedRows.join('\n')}`;
			} else if (entry.type === 'list') {
				return entry.items.map(item => `- ${item}`).join('\n');
			} else {
				return `***${entry.name}.*** ${entry.entries.map(entryMapper).join('\n')}`;
			}
		}

		let entriesToProc = entries;
		if (isString(entries.last()) && (entries.last().match(/damage increases(?: by (?:{[^}]+}|one die))? when you reach/) || entries.last().match(/creates more than one beam when you reach/))) {
			newSpell.description = '';
			entriesToProc = entries.slice(0, -1);
			newSpell.higherLevel = fixLinks(entries.last());
		}

		newSpell.description = fixLinks(entriesToProc.map(entryMapper).join('\n'));
	}

	function addExtraSpellData (newSpell, data) {
		if (data['Spell Attack']) {
			newSpell.attack = {
				type: data['Spell Attack'].toLocaleLowerCase()
			};
		}

		if (data.Save) {
			newSpell.save = {
				ability: data.Save
			};
			if (data['Save Success']) {
				newSpell.save.saveSuccess = data['Save Success'].toLocaleLowerCase();
			}
		}

		const secondOutput = (data.primaryDamageCondition === data.secondaryDamageCondition) ? SECONDARY_DAMAGE_OUTPUTS_NAMES : PRIMARY_DAMAGE_OUTPUT_NAMES;

		[
			[
				PRIMARY_DAMAGE_PROP_NAMES,
				PRIMARY_DAMAGE_OUTPUT_NAMES
			],
			[
				SECONDARY_DAMAGE_PROP_NAMES,
				secondOutput
			]
		].forEach(propNamesArray => {
			const propNames = propNamesArray[0];
			const outputNames = propNamesArray[1];
			if (data[propNames.damage] && data[propNames.damageType] !== 'Effect') {
				switch (data[propNames.condition]) {
					case 'save':
						processDamageInfo(data, newSpell.save, propNames, outputNames);
						break;
					case 'attack':
						processDamageInfo(data, newSpell.attack, propNames, outputNames);
						break;
					case 'auto':
						newSpell.damage = newSpell.damage || {};
						processDamageInfo(data, newSpell.damage, propNames, outputNames);
						break;
					default:
						throw new Error('Missing ' + propNames.condition + ' for spell ' + newSpell.name);
				}
			}
		});

		if (data.Healing) {
			newSpell.heal = {};

			const healMatch = data.Healing.match(/^(\d+d\d+)?(?:\s?\+\s?)?(\d+)?$/);
			if (healMatch) {
				if (healMatch[1]) {
					newSpell.heal.heal = healMatch[1];
				}
				if (healMatch[2]) {
					newSpell.heal.bonus = parseInt(healMatch[2], 10);
				}
			} else {
				newSpell.heal.heal = data.Healing;
			}

			if (data['Add Casting Modifier'] === 'Yes') {
				newSpell.heal.castingStat = true;
			}
			if (data['Higher Spell Slot Dice'] && data.Healing.match(/\d+(?:d\d+)/)) {
				newSpell.heal.higherLevelDice = parseInt(data['Higher Spell Slot Dice'], 10);
			}

			if (data['Higher Level Healing']) {
				newSpell.heal.higherLevelAmount = parseInt(data['Higher Level Healing'], 10);
			}
		}
	}

	const PRIMARY_DAMAGE_PROP_NAMES = {
		damage: 'Damage',
		damageProgression: 'Damage Progression',
		damageType: 'Damage Type',
		higherLevel: 'Higher Spell Slot Dice',
		castingStat: 'Add Casting Modifier',
		condition: 'primaryDamageCondition'
	};

	const PRIMARY_DAMAGE_OUTPUT_NAMES = {
		outputDamage: 'damage',
		outputDamageBonus: 'damageBonus',
		outputDamageType: 'damageType',
		outputHigherLevel: 'higherLevelDice',
		outputCastingStat: 'castingStat'
	};

	const SECONDARY_DAMAGE_PROP_NAMES = {
		damage: 'Secondary Damage',
		damageType: 'Secondary Damage Type',
		damageProgression: 'Secondary Damage Progression',
		higherLevel: 'Secondary Higher Spell Slot Dice',
		castingStat: 'Secondary Add Casting Modifier',
		condition: 'secondaryDamageCondition'

	};

	const SECONDARY_DAMAGE_OUTPUTS_NAMES = {
		outputDamage: 'secondaryDamage',
		outputDamageBonus: 'secondaryDamageBonus',
		outputDamageType: 'secondaryDamageType',
		outputHigherLevel: 'higherLevelSecondaryDice',
		outputCastingStat: 'secondaryCastingStat'
	};

	function processDamageInfo (data, outputObject, propNames, outputNames) {
		if (data[propNames.damage]) {
			if (data[propNames.damageProgression]) {
				if (data[propNames.damageProgression] === 'Cantrip Dice') {
					outputObject[outputNames.outputDamage] = '[[ceil((@{level} + 2) / 6)]]' + data[propNames.damage].replace(/\d+(d\d+)/, '$1');
				} else {
					outputObject[outputNames.outputDamage] = data[propNames.damage];
				}
			} else {
				const damageMatch = data[propNames.damage].match(/^(\d+d\d+)?(?:\s?\+\s?)?(\d+)?$/);
				if (damageMatch) {
					if (damageMatch[1]) {
						outputObject[outputNames.outputDamage] = damageMatch[1];
					}
					if (damageMatch[2]) {
						outputObject[outputNames.outputDamageBonus] = damageMatch[2];
					}
				} else {
					outputObject[outputNames.outputDamage] = data[propNames.damage];
				}
			}
			if (data[propNames.damageType]) {
				outputObject[outputNames.outputDamageType] = data[propNames.damageType].toLocaleLowerCase();
			}

			if (data[propNames.higherLevel]) {
				const parseFunc = data[propNames.higherLevel].includes('.') ? parseFloat : parseInt;
				outputObject[outputNames.outputHigherLevel] = parseFunc(data[propNames.higherLevel]);
			}

			if (data[propNames.castingStat] === 'Yes') {
				outputObject[outputNames.outputCastingStat] = true;
			}
		}
	}

	function processHigherLevel (entriesHigherLevel, newSpell) {
		if (entriesHigherLevel) {
			newSpell.higherLevel = fixLinks(entriesHigherLevel[0].entries.join('\n'));
		}
	}

	function processSpell (spell, additionalSpellData) {
		const newSpell = {
			name: spell.name,
			level: spell.level,
			school: Parser.spSchoolAbvToFull(spell.school)
		};

		if (spell.meta && spell.meta.ritual) {
			newSpell.ritual = true;
		}

		Object.assign(newSpell, {
			castingTime: Parser.spTimeListToFull(spell.time),
			range: Parser.spRangeToFull(spell.range),
			components: Parser.spComponentsToFull(spell.components),
			duration: Parser.spDurationToFull(spell.duration)
		});

		processSpellEntries(spell.entries, newSpell);
		processHigherLevel(spell.entriesHigherLevel, newSpell);
		addExtraSpellData(newSpell, additionalSpellData[spell.name]);

		return newSpell;
	}

	function serialiseFixer (key, value) {
		if (isString(value)) {
			return value
				.replace(/'/g, '’')
				.replace(/([\s(])"(\w)/g, '$1“$2')
				.replace(/([\w,.])"/g, '$1”');
		}

		if (isObject(value)) {
			if (value.recharge) {
				return Object.assign({
					name: value.name,
					recharge: value.recharge
				}, value);
			}
			if (value.cost) {
				if (value.cost === 1) {
					delete value.cost;
				} else {
					return Object.assign({
						name: value.name,
						cost: value.cost
					}, value);
				}
			}
		}

		return value;
	}

	function convertData (inputs, srdMonsters, srdSpells, srdSpellRenames, additionalSpellData, legendaryGroup) {
		const spellLevels = {};
		const toProcess = Object.values(inputs)
			.filter(input => !input.converted && (isObject(input.monsterInput) || isObject(input.spellInput)));

		toProcess.forEach(data => {
			if (data.monsterInput) {
				if (data.monsterInput.legendaryGroup) {
					data.monsterInput.legendaryGroup.forEach(monsterDetails => legendaryGroup[monsterDetails.name] = monsterDetails);
				}
				data.monsters = data.monsterInput.map(monster => {
					try {
						const converted = processMonster(monster, legendaryGroup);
						if (srdMonsters.includes(monster.name)) {
							const pruned = (({name, lairActions, regionalEffects, regionalEffectsFade}) => ({
								name,
								lairActions,
								regionalEffects,
								regionalEffectsFade
							}))(converted);
							if (Object.values(pruned).filter(v => !!v).length > 1) {
								return pruned;
							}
							return null;
						}
						return converted;
					} catch (e) {
						throw new Error('Error with monster ' + monster.name + ' in file ' + data.name + ': ' + e.toString() + e.stack);
					}
				})
					.filter(m => !!m)
					.sort((a, b) => a.name.localeCompare(b.name));
			}

			if (data.spellInput) {
				data.spells = data.spellInput.map(spell => {
					spellLevels[spell.name] = spell.level;
					spell.classes.fromClassList.forEach(clazz => {
						if ((srdSpells.includes(spell.name) || srdSpells.includes(srdSpellRenames[spell.name])) && clazz.source === SRC_PHB) {
							return;
						}
						const nameToAdd = srdSpellRenames[spell.name] || spell.name;
						const sourceObject = clazz.source === SRC_PHB ? data : inputs[clazz.source];
						if (!sourceObject) {
							return;
						}
						sourceObject.classes = sourceObject.classes || {};
						sourceObject.classes[clazz.name] = sourceObject.classes[clazz.name] || {
							archetypes: [],
							spells: []
						};
						sourceObject.classes[clazz.name].spells.push(nameToAdd);
					});

					(spell.classes.fromSubclass || []).forEach(subclass => {
						if ([
							'Life',
							'Devotion',
							'Land',
							'Fiend'
						].includes(subclass.subclass.name)) {
							return;
						}

						if (!inputs[subclass.class.source]) {
							return;
						}

						const sourceObject = subclass.subclass.source === SRC_PHB ? data : inputs[subclass.subclass.source];
						if (!sourceObject) {
							return;
						}
						sourceObject.classes[subclass.class.name] = sourceObject.classes[subclass.class.name] || {
							archetypes: [],
							spells: []
						};
						const archetypeName = subclass.subclass.subSubclass || subclass.subclass.name;
						let archetype = sourceObject.classes[subclass.class.name].archetypes.find(arch => arch.name === archetypeName);
						if (!archetype) {
							archetype = {
								name: archetypeName,
								spells: []
							};
							sourceObject.classes[subclass.class.name].archetypes.push(archetype);
						}
						archetype.spells.push(spell.name);
					});
					if (srdSpells.includes(spell.name)) {
						return null;
					}
					if (srdSpellRenames[spell.name]) {
						return {
							name: srdSpellRenames[spell.name],
							newName: spell.name
						};
					}
					try {
						return processSpell(spell, additionalSpellData);
					} catch (e) {
						throw new Error('Error with spell ' + spell.name + ' in file ' + data.name + ':' + e.toString() + e.stack);
					}
				})
					.filter(s => !!s)
					.sort((a, b) => a.name.localeCompare(b.name));
			}
		});

		const levelThenAlphaComparer = (spellA, spellB) => {
			const levelCompare = spellLevels[spellA] - spellLevels[spellB];
			return levelCompare === 0 ? spellA.localeCompare(spellB) : levelCompare;
		};

		toProcess.forEach(input => {
			input.converted = {
				name: input.name,
				dependencies: input.dependencies,
				version: '2.0.0'
			};
			if (input.classes && !isEmpty(input.classes)) {
				input.converted.classes = Object.keys(input.classes)
					.map(name => {
						const clazz = input.classes[name];
						if (clazz.spells && clazz.spells.length > 0) {
							clazz.spells.sort(levelThenAlphaComparer);
						} else {
							delete clazz.spells;
						}
						if (clazz.archetypes.length === 0) {
							delete clazz.archetypes;
						} else {
							clazz.archetypes.sort((a, b) => a.name.localeCompare(b.name));
							clazz.archetypes.forEach(arch => arch.spells.sort(levelThenAlphaComparer));
						}
						return Object.assign({name}, clazz);
					})
					.sort((a, b) => a.name.localeCompare(b.name));
			}
			if (input.monsters && input.monsters.length > 0) {
				input.converted.monsters = input.monsters;
			}
			if (input.spells && input.spells.length > 0) {
				input.converted.spells = input.spells;
			}
		});
	}

	function flattener (result, item) {
		if (Array.isArray(item)) {
			result.push(...item);
		} else {
			result.push(item);
		}
		return result;
	}

	function isObject (obj) {
		const type = typeof obj;
		return (type === 'function' || type === 'object') && !!obj;
	}

	function isString (str) {
		return typeof str === 'string';
	}

	function isNumber (obj) {
		return toString.call(obj) === '[object Number]';
	}

	function isEmpty (obj) {
		if (obj == null) {
			return true;
		}
		if (Array.isArray(obj) || isString(obj)) {
			return obj.length === 0;
		}
		return Object.keys(obj).length === 0;
	}

	function objMap (obj, func) {
		return Object.keys(obj).map((key) => {
			return func(obj[key], key, obj);
		})
	}

	return {
		getInputs,
		generateShapedJS
	}
}());

window.onload = function load () {
	ShapedConverter.getInputs().then((inputs) => {
		return Object.values(inputs).sort((a, b) => {
			if (a.name === 'Player\'s Handbook') {
				return -1;
			} else if (b.name === 'Player\'s Handbook') {
				return 1;
			}
			return a.name.localeCompare(b.name);
		});
	}).then(inputs => {
		inputs.forEach(input => {
			const disabled = input.name === 'Player\'s Handbook' ? 'disabled="disabled" ' : '';
			const checked = input.name === 'Player\'s Handbook' ? 'checked="checked" ' : '';
			$('#sourceList').append($(`<li><label><input type="checkbox" ${disabled}${checked} value="${input.key}"><span>${input.name}</span></label></li>`));
		});
	}).catch(e => {
		alert(e);
	});

	const $btnSaveFile = $(`<div class="btn btn-primary">Prepare JS</div>`);
	$(`#buttons`).append($btnSaveFile);
	$btnSaveFile.on('click', () => {
		const keys = $('input[type="checkbox"]:checked').map((i, e) => {
			return e.value;
		}).get();
		ShapedConverter.generateShapedJS(keys)
			.then(js => {
				$('#shapedJS').val(js);
				$('#copyJS').removeAttr('disabled');
			})
			.catch(e => alert(e));
	});
	$('#copyJS').on('click', () => {
		const shapedJS = $('#shapedJS');
		shapedJS.select();
		document.execCommand('Copy');
	});
};
