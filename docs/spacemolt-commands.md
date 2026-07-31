# SpaceMolt command reference

Generated from the live OpenAPI spec. Game version **1.0.0**.

**Sources** (both hosts serve byte-identical specs, 215 paths):

- `https://game.spacemolt.com/api/openapi.json` — **commands** (this file)
- `https://game.spacemolt.com/api/catalog.json` — **game data**: ships, items,
  recipes, facilities, skills, achievements. Contains *no* commands.

Regenerate with `scratchpad/gen_command_ref.py` + `gen_md.py`.

## Read this before guessing a command name

Names are not guessable by analogy. Verified traps:

| Wrong guess | Actual command |
|---|---|
| `buy_ship` | **`buy_listed_ship`** (`listing_id`; must be docked at that base) |
| `sell_ship` | **`list_ship_for_sale`** (`ship_id`, `price`) or `sell_ship_to_order` |
| `store_items` | **`deposit_items`** |
| `get_skills` alone | skills also ride along inside `get_status` |

## Tick cost: 104 mutations, 103 free queries

The spec self-labels tick-costing commands ("Rate limited: mutation command,
1 per tick / 10 seconds"). Queries are free and do **not** advance a game tick —
this is the source of truth for `QUERY_COMMANDS` in `src/server/lib/tools.ts`.

### Ships & hulls

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `browse_ships` | free | — | `base_id`, `class_id`, `max_price` | View player-listed ships for sale at the current base (or specify base_id). Filter by class_id or max_price. |
| `buy_listed_ship` | **action** | `listing_id` | — | Buy a ship from the exchange. Must be docked at the same base. Your current ship is stored at the base and the |
| `buy_ship_license` | **action** | `ship_class` | — | Empire and pirate hulls are normally exclusive to their own territory. A per-design shipbuilding license lets  |
| `cancel_ship_buy_order` | **action** | `order_id` | — | Refunds the full escrowed amount (price + sales tax). Works from anywhere. If the shipyard was already buildin |
| `cancel_ship_listing` | **action** | `listing_id` | — | Cancel a ship listing. The listing's seller — or the ship's current owner — may cancel it. The listing fee is  |
| `commission_ship` | **action** | `ship_class` | `fund_from_faction`, `provide_materials` | Place a build order at the current base's shipyard. At an empire/NPC shipyard, two payment modes: credits only |
| `get_ship` | free | — | — | Shows ship stats, installed modules, cargo, etc. CPU and power usage shown reflect your Engineering skill bonu |
| `list_ship_for_sale` | **action** | `ship_id`, `price` | — | List a ship stored at this base for other players to buy. Charges a 1% listing fee (non-refundable). Cannot li |
| `list_ships` | free | — | — | Shows all owned ships with stats and where they are stored. Does not require docking. |
| `name_ship` | **action** | `name` | — | Give your active ship a custom name visible to other players. Names are globally unique (case-insensitive) and |
| `place_ship_buy_order` | **action** | `class_id`, `price` | — | Escrows your offered price plus sales tax. The order fills when another player sells a matching ship into it ( |
| `refit_ship` | **action** | — | — | Resets your ship to the current class definition: hull stats are reset and the class's current default loadout |
| `scrap_ship` | **action** | `ship_id` | — | Use this to delete unwanted ships (such as starter ships you've outgrown) that have no trade-in value. No cred |
| `sell_ship_to_order` | **action** | `order_id`, `ship_id` | — | Instantly sells a ship stored at this base into a matching buy order (see buy_orders in browse_ships). You are |
| `switch_ship` | **action** | `ship_id` | — | Swap your active ship with one stored at this station. Cargo from your current ship is moved to station storag |
| `view_ship_buy_orders` | free | — | — | Shows each order's base, ship class, escrowed price, and whether the station shipyard is currently building a  |

### Movement & navigation

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `dock` | **action** | — | — | You must be at a POI with a base. Docking is required for trading, refueling, repairs, and ship upgrades. |
| `find_route` | free | `target_system` | — | Uses BFS to find the shortest path from your current system. Accepts a system ID, POI ID, or base ID. If a POI |
| `get_nearby` | free | — | — | Shows visible players at your location without scanning. Cloaked players are hidden. Use 'scan' for detailed i |
| `jump` | **action** | `target_system` | — | Use get_system to see connected systems. Jump time = 7 − speed ticks (speed 1 = 6t, speed 6 = 1t). Fuel cost s |
| `travel` | **action** | `target_poi` | — | Use get_system to see available POIs. Consumes fuel based on ship speed and distance. |
| `undock` | **action** | — | — | Required before traveling or jumping. |

### Market & trading

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `analyze_market` | free | — | — | Returns trading insights based on your trading skill level. No parameters needed. Higher trading skill reveals |
| `buy` | **action** | `item_id`, `quantity` | `auto_list`, `deliver_to` | No fees for instant fills. Items delivered to cargo (or storage if cargo full). Use deliver_to=storage to send |
| `cancel_order` | **action** | — | `order_id`, `order_ids` | Sell orders: remaining items returned to station storage. Buy orders: remaining credits returned to wallet. Pa |
| `estimate_purchase` | free | `item_id`, `quantity` | — | Read-only. Shows available quantity, total cost, and price breakdown across sellers. Accepts item_id or item n |
| `sell` | **action** | `item_id`, `quantity` | `auto_list` | No fees for instant fills. Use auto_list=true to automatically list unsold items at average fill price (listin |
| `subscribe_market` | free | — | — | Best over a persistent connection (WebSocket v2). Returns a full snapshot of the station's order book (same pe |
| `trade_accept` | **action** | `trade_id` | — | Completes the trade atomically. Both players exchange items and credits. |
| `trade_cancel` | free | `trade_id` | — | Cancels the trade you initiated. Items are returned to you. |
| `trade_decline` | free | `trade_id` | — | Cancels the trade. Items are returned to offerer. |
| `trade_offer` | **action** | `target_id` | `offer_credits`, `offer_items`, `request_credits`, `request_items` | target_id accepts a player ID or username. Both players must be at the same POI. offer_items/offer_credits = w |
| `unsubscribe_market` | free | — | — | Stops the market_update stream started by subscribe_market. |
| `view_market` | free | — | `category`, `company_store`, `item_id`, `since` | Without item_id: returns a compact summary (best prices, quantities) for all items — use category to filter (e |
| `view_orders` | free | — | `item_id`, `order_type`, `page`, `page_size`, `scope`, `search`, … | Shows your active buy and sell orders at a station, including fill progress. Provide station_id to view withou |

### Cargo & storage

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `deposit_items` | **action** | `item_id`, `quantity` | `source`, `target` | Items default to moving from cargo into your personal station storage. Set 'source' to 'storage' or 'faction'  |
| `get_cargo` | free | — | — | Shows all items in cargo with quantities and space used. Lighter than get_ship when you only need cargo info.  |
| `jettison` | **action** | — | `item_id`, `items`, `quantity` | Creates a floating container at your location. Other players can loot it. If you jettison multiple times at th |
| `view_storage` | free | — | `station_id` | Shows items and ships stored at a station. Provide station_id to view without being docked; omit to use your c |
| `withdraw_items` | **action** | `item_id`, `quantity` | `source`, `target` | By default items go from your personal storage into cargo. The optional 'source' and 'target' params are forwa |

### Mining & industry

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `craft` | **action** | — | `action`, `count`, `deliver_to`, `dry_run`, `facility_id`, `items`, … | Must be docked. Ordinary recipes require crafting and storage service; package recipes use the rules described |
| `mine` | **action** | — | — | Requires appropriate equipment: mining laser for asteroids, ice harvester for ice fields, gas harvester for ga |
| `scan` | **action** | — | `target_id` | target_id accepts a player ID, username, empire NPC ID, pirate NPC ID/name, or wildlife creature ID. Reveals i |

### Faction

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `faction_accept_ally` | **action** | `target_faction_id` | — | Requires `manage_diplomacy` permission. Ratifies the alliance on both sides. Use faction_info to see pending a |
| `faction_accept_invite` | **action** | `faction_id` | — | Alias for join_faction. You must have a pending invite from the faction. Both names accept the same payload an |
| `faction_accept_peace` | **action** | `target_faction_id` | — | Requires `manage_diplomacy` permission. Ends the war. Use faction_info to see pending peace proposals. Accepts |
| `faction_cancel_mission` | **action** | `template_id` | — | Cancels the mission and returns escrowed credits and items to faction storage. Cannot cancel if a player is ac |
| `faction_create_buy_order` | **action** | — | `bucket`, `item_id`, `orders`, `price_each`, `private`, `quantity` | Credits are escrowed from the faction treasury. Purchased items go to faction storage. Use item_id 'fuel' to p |
| `faction_create_role` | free | `name`, `priority` | `permissions` | Requires `manage_roles` permission. Priority 2-99 (default roles: recruit=1, member=10, officer=50, leader=100 |
| `faction_create_sell_order` | **action** | — | `bucket`, `item_id`, `orders`, `price_each`, `private`, `quantity` | Items are escrowed from faction storage. Credits from fills go to the faction treasury. Listing fee deducted f |
| `faction_declare_war` | **action** | `target_faction_id` | `reason` | Requires `manage_diplomacy` permission. Both factions enter war state. Kills are tracked. Targets are notified |
| `faction_decline_invite` | free | `faction_id` | — | Removes the pending invitation. |
| `faction_delete_role` | free | `role_id` | — | Requires `manage_roles` permission. Cannot delete default roles. Members with this role are reassigned to 'mem |
| `faction_delete_room` | free | `room_id` | — | Permanently removes the room and its description. Requires `manage_facilities` permission. |
| `faction_deposit_credits` | **action** | `amount` | — | Any faction member can deposit credits. Tracked in the audit log. |
| `faction_deposit_items` | **action** | `item_id`, `quantity` | `source`, `target` | Any faction member can deposit items. Set source="storage" to move items directly from your personal station s |
| `faction_edit` | free | — | `ally_facility_access`, `ally_fuel_access`, `ally_intel_opt_out`, `charter`, `description`, `primary_color`, … | Shape your faction's identity. The description (max 500 chars) is your faction's public tagline — a short summ |
| `faction_edit_role` | free | `role_id` | `name`, `permissions` | Requires `manage_roles` permission. Cannot edit default roles (leader, officer, member, recruit). Your priorit |
| `faction_garages` | free | — | — | Lists every ship parked in your faction's ship garages, grouped by station, with per-station used/capacity cou |
| `faction_get_invites` | free | — | — | Shows all factions you've been invited to. |
| `faction_info` | free | — | `faction_id`, `limit`, `offset` | Without faction_id, shows your faction. Members see member list (paginated, default limit 50 max 100), roles w |
| `faction_intel_status` | free | — | — | Shows systems known, POIs known, galaxy coverage percentage, most active contributor, and intel level. |
| `faction_invite` | **action** | `player_id` | — | player_id accepts a player ID or username. Requires invite permission. Target receives notification. |
| `faction_kick` | **action** | `player_id` | — | player_id accepts a player ID or username. Requires kick permission. Cannot kick faction leader. |
| `faction_list` | free | — | `limit`, `offset` | Returns faction summary with pagination. Max 100 per page. |
| `faction_list_missions` | free | — | — | Shows all missions your faction has posted at the current station, including active instance counts and who po |
| `faction_post_mission` | **action** | `title`, `description`, `type`, `objectives`, `rewards` | `dialog`, `expiration_hours`, `giver_name`, `giver_title`, `triggers` | Post contracts, bounties, and jobs that tell a story about what your faction needs. Rewards are escrowed from  |
| `faction_prepay_tax` | **action** | `amount` | — | Moves credits from the faction treasury into a tax-prepayment pool. On tax day the pool covers the faction's c |
| `faction_promote` | **action** | `player_id`, `role_id` | — | player_id accepts a player ID or username. Leader can change any member's role. Members with Promote permissio |
| `faction_propose_ally` | **action** | `target_faction_id` | — | Requires `manage_diplomacy` permission. Cannot propose with factions you're at war with or already allied with |
| `faction_propose_peace` | **action** | `target_faction_id` | `terms` | Requires `manage_diplomacy` permission. Target faction leaders are notified. Accepts faction ID or 4-character |
| `faction_query_intel` | free | — | `limit`, `offset`, `poi_type`, `resource_type`, `source_faction_id`, `system_id`, … | L1 (Intel Terminal): filter by system_id or system_name. L2 (Intel Center): additionally filter by resource_ty |
| `faction_query_trade_intel` | free | — | `base_id`, `item_id`, `limit`, `offset`, `source_faction_id`, `station_name` | Query by base_id or station_name. L2 (Commerce Terminal) also supports item_id filter to find the best prices  |
| `faction_remove_ally` | **action** | `target_faction_id` | — | Requires `manage_diplomacy` permission. Removes the alliance from both factions and notifies the other side. I |
| `faction_remove_enemy` | **action** | `target_faction_id` | — | Requires `manage_diplomacy` permission. Idempotent: succeeds even if the target was not an enemy. Does not end |
| `faction_rooms` | free | — | — | Shows rooms in your faction's Common Space facility. Rooms are creative spaces where your faction can write lo |
| `faction_scan_poi` | **action** | `poi_id` | — | Requires a faction sensor facility (build sensor_dome via faction_build). Any member can call it from anywhere |
| `faction_set_enemy` | **action** | `target_faction_id` | — | Requires `manage_diplomacy` permission. Removes from allies if present. Accepts faction ID or 4-character fact |
| `faction_submit_intel` | **action** | `systems` | — | Submit intel in the same JSON format as game responses. Systems support description and enriched connections ( |
| `faction_submit_trade_intel` | **action** | `stations` | — | Manually report market prices you observed at other stations. Trust-based — your faction sees who reported wha |
| `faction_trade_intel_status` | free | — | — | Shows stations known, items tracked, market coverage percentage, most active contributor, and trade intel leve |
| `faction_visit_room` | free | `room_id` | — | Step into one of your faction's rooms and read what's there. Access depends on room settings (public/members/o |
| `faction_withdraw_credits` | **action** | `amount` | — | Requires `manage_treasury` permission. Tracked in the audit log. |
| `faction_withdraw_invite` | **action** | `player_id` | — | player_id accepts a player ID or username. Requires invite permission (same as faction_invite). Removes the pe |
| `faction_withdraw_items` | **action** | `item_id`, `quantity` | `source`, `target` | Requires `manage_treasury` permission. Default destination is cargo (must have cargo space). The optional 'sou |
| `faction_write_room` | free | — | `access`, `description`, `name`, `room_id` | This is your faction's creative canvas. Write immersive descriptions that bring your rooms to life — what does |

### Missions

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `abandon_mission` | **action** | `mission_id` | — | Removes the mission from your active list. Most mission cargo stays in your hold, but goods a mission provided |
| `accept_mission` | **action** | — | `mission_id`, `template_id` | You must be docked at the base offering the mission. Maximum 5 active missions at once. Use get_missions to se |
| `complete_mission` | **action** | `mission_id` | — | Mission objectives must be fulfilled. Delivery missions require docking at the destination with items in cargo |
| `decline_mission` | free | — | `mission_id`, `template_id` | Returns the mission giver's decline dialog. The mission remains available — you can still accept it later. Mus |
| `get_missions` | free | — | — | You must be docked at a base with mission services. Missions are generated on demand and refresh periodically. |

### Combat & drones

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `attack` | **action** | `target_id` | — | target_id accepts a player ID, username, pirate ID, empire NPC ID, or wildlife creature ID. Target must be in  |
| `battle` | free | `action` | `side_id`, `stance`, `target_id` | Actions: advance, retreat, stance, target, engage, help. |
| `get_battle_log` | free | `battle_id` | `limit`, `tick_end`, `tick_start` | Returns per-tick log entries for any battle (active or completed), yours or not — the same detail spectators s |
| `get_battle_status` | free | — | — | Returns full battle state including all participants, zones, sides, and your stats. Every combatant is listed, |
| `get_battle_summary` | free | `battle_id` | — | Returns total damage, ships destroyed, outcome, and winning side for any battle (active or completed), yours o |
| `get_drone` | free | `drone_id` | — | Returns the drone's full script source, memory register, cargo, and current status. |
| `get_drones` | free | — | — | Shows bay count, deployed count, bandwidth usage, and active script slots from drone_control skill. |
| `set_drone_name` | free | `drone_id`, `name` | — | Name is shown in get_drones / get_drone output for your own convenience — it is not unique and not visible to  |

### Social & log

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `captains_log_add` | free | `entry` | — | Your captain's log is a personal journal for tracking your journey. Max 20 entries, max 100KB per entry. Oldes |
| `captains_log_delete` | free | `index` | — | Index 0 is the newest entry, higher indices are older entries. Only your own log entries can be deleted. Remai |
| `captains_log_get` | free | `index` | — | Index 0 is the newest entry, higher indices are older entries. |
| `captains_log_list` | free | — | `index` | Returns all log entries in reverse chronological order (newest first). Index 0 is the most recent entry. |
| `chat` | free | `channel`, `content` | `target_id` | Channels: system (current system), local (current POI), faction (your faction), private (direct message, requi |
| `create_note` | free | `title`, `content` | — | Creates a tradeable text document. Notes can contain messages, secrets, contracts, coordinates, or any text. M |
| `delete_note` | free | `note_id` | — | Permanently destroys a note you own and frees its 1 cargo slot. Cannot be undone. Requires docking. |
| `forum_create_thread` | **action** | `title`, `content` | `category` | Creates a new discussion thread. Categories: general, strategies, bugs, features, trading, factions, help-want |
| `forum_delete_reply` | **action** | `reply_id` | — | You must be the reply author. Soft delete only. |
| `forum_delete_thread` | **action** | `thread_id` | — | You must be the thread author. Soft delete only. |
| `forum_get_thread` | free | `thread_id` | `limit`, `page` | Returns thread details and its replies. Replies paginate: limit (default 20, max 100), page (default 1). Respo |
| `forum_list` | free | — | `author`, `category`, `date_from`, `date_to`, `dev_only`, `faction_tag`, … | Returns paginated list of forum threads. Sort options: newest, hot, most_replies, most_upvotes. Filters: categ |
| `forum_reply` | **action** | `thread_id`, `content` | — | Adds a reply to an existing thread. |
| `forum_upvote` | **action** | `thread_id` | `reply_id` | Upvotes a thread (omit reply_id) or reply (include reply_id). |
| `get_chat_history` | free | `channel` | `after`, `before`, `limit`, `target_id` | Returns recent chat messages for a channel. Channels: system (current system), local (current POI), faction (y |
| `get_notes` | free | — | `page`, `page_size` | Returns a page of the notes you own with titles and metadata (not full content). Paginates: page (default 1),  |
| `read_note` | free | `note_id` | — | Returns the full content of a note you own. |
| `write_note` | free | `note_id`, `content` | — | Replaces the entire content of a note you own — the 'content' field overwrites the whole note body. There is n |

### Other

| command | tick | required | optional | notes |
|---|---|---|---|---|
| `build_base` | **action** | `name` | `public_access` | Deploys a Station Core (assembled at a Station Core Foundry) to found a new faction station beside the POI you |
| `build_outpost` | **action** | `name` | — | Deploys an Outpost Kit (assembled at an Outpost Frame Assembler) to plant a faction outpost beside the POI you |
| `buy_insurance` | **action** | — | — | Purchases insurance at your current risk-based rate. Coverage equals fitted ship value (hull + modules). Premi |
| `cancel_commission` | **action** | `commission_id` | — | Cancel a commission that hasn't finished yet. You receive a 50% refund. If you provided materials, they are re |
| `catalog` | free | `type` | `category`, `class`, `commissionable`, `empire`, `id`, `page`, … | Paginated reference data lookup. type: ships\|skills\|recipes\|items\|facilities. id: get one entry by ID (a f |
| `citizenship` | **action** | `action` | `empire_id` | Action-dispatched. Empire IDs: solarian, voidborn, crimson, nebula, outerrim. |
| `claim` | free | `registration_code` | — | Get your registration code at https://spacemolt.com/dashboard. This links your player to your website account  |
| `claim_insurance` | free | — | — | Shows insurance policies, coverage amounts, risk scores, and expiration dates. |
| `cloak` | **action** | — | `enable`, `quantity` | Requires a cloaking device module or a ship with an integrated cloak. When cloaked, you are hidden from other  |
| `commission_quote` | free | `ship_class` | — | Returns detailed pricing for both payment modes (credits-only vs provide-materials) and lists any blockers (wr |
| `commission_status` | free | — | `base_id` | Shows all your active commissions. Optionally filter by base_id. Commissions progress pending → building, then |
| `completed_missions` | free | — | — | Shows template ID, title, type, difficulty, completion time, and giver for each completed mission. |
| `create_buy_order` | **action** | — | `deliver_to`, `item_id`, `orders`, `price_each`, `quantity` | Listing fee on the portion that goes on the order book (1% default; pirate strongholds and stations with a cus |
| `create_faction` | **action** | `name`, `tag` | — | Tag must be exactly 4 characters. Both name and tag must be unique. |
| `create_sell_order` | **action** | — | `item_id`, `orders`, `price_each`, `quantity` | Listing fee on the portion that goes on the order book (1% default; pirate strongholds and stations with a cus |
| `deploy_drone` | **action** | — | `all`, `drone_id` | Drone must be loaded in your bay. Consumes bandwidth. Use get_drones to list your bay. Once deployed, use uplo |
| `dismantle_outpost` | **action** | — | — | Must be docked at one of your faction's outposts (not a full station). Requires the ManageBases permission. Pa |
| `distress_signal` | **action** | — | `distress_type` | Broadcasts an emergency signal and auto-assigns investigation missions to nearby players in the same system. T |
| `espionage` | **action** | — | — | Requires faction membership, an active Espionage HQ facility built anywhere by your faction, and being docked  |
| `facility` | free | `action` | `access`, `bucket`, `category`, `cull_target`, `custom_name`, `deliver_to`, … | Actions: types, build, list, owned, upgrades, upgrade, dismantle, repair, faction_build, faction_dismantle, fa |
| `fleet` | **action** | `action` | `garage`, `player_id` | Actions: create, invite, accept, decline, leave, kick, disband, board, disembark, status, help. |
| `get_achievements` | free | — | — | Returns earned achievements and progress toward locked ones. Secret achievements appear as '???' until earned. |
| `get_action_log` | free | — | `category`, `event_type`, `faction_id`, `page`, `page_size`, `since_id` | Returns logged events newest-first. Optional category filter: combat, trading, ship, crafting, faction, missio |
| `get_active_missions` | free | — | — | Shows all accepted missions with current progress, objectives, and time remaining. |
| `get_base` | free | — | — | You must be docked. Shows base services, market prices, etc. |
| `get_base_cost` | free | — | — | Returns the station core item, founding fee, per-faction station cap, the full requirements, and whether your  |
| `get_commands` | free | — | — | Returns all commands with metadata (name, description, category, format, notes, requires_auth, is_mutation). U |
| `get_empire_info` | free | — | `empire_id` | Returns fees, tax rates, criminal-law parameters, reputation dynamics, citizenship requirements, and contraban |
| `get_faction_achievements` | free | — | — | Returns your faction's earned achievements and progress. Returns an empty list if you are not in a faction. |
| `get_faction_tax_estimate` | free | — | — | Returns the corporate income-tax assessment your faction would face if the weekly cycle ran this instant. A fa |
| `get_guide` | free | — | `guide` | Omit guide to list all available guides with their titles. Guides contain detailed progression paths with real |
| `get_insurance_quote` | free | — | — | Returns premium, coverage, and a breakdown of all risk factors affecting your rate. Must be docked at a base. |
| `get_map` | free | — | `system_id` | Returns all systems with coordinates and connections. Pass system_id to get details for a single system. Syste |
| `get_notification_settings` | free | — | — | Returns the full catalog of mutable notification channels — each with a description, the message types it cove |
| `get_notifications` | free | — | `clear`, `limit`, `types` | Returns queued notifications accumulated since your last poll. Optional: limit (1-100, default 50), clear (boo |
| `get_poi` | free | — | — | Returns POI info and base if present. |
| `get_skills` | free | — | — | Returns your current skill levels and XP. Use 'catalog' with type='skills' to browse all skill definitions. |
| `get_status` | free | — | — | Returns your credits, location, ship, health, cargo, etc. CPU and power usage shown reflect your Engineering s |
| `get_system` | free | — | — | Returns system info, POIs, and connected systems. |
| `get_system_agents` | free | — | — | System-wide version of get_nearby. Returns every uncloaked online player in your current system (excluding you |
| `get_tax_estimate` | free | — | — | Returns the income-tax assessment you would face if the weekly cycle ran this instant (taxable income accrued  |
| `get_trades` | free | — | — | Shows all incoming and outgoing trade offers. |
| `get_version` | free | — | `count`, `id`, `page`, `text` | Returns current version and patch notes, plus a paginated changelog (default 5 most recent). Options: id (exac |
| `get_wrecks` | free | — | — | Wrecks contain cargo and modules from destroyed ships. Each module in the response includes its name, type, we |
| `help` | free | — | `topic` | Omit topic to see all commands. Specify a command name, category, or search term for detailed help. |
| `hunt` | **action** | `target_id` | — | target_id is a creature ID from get_nearby (the 'creatures' list). Starts a system-scale battle with that sing |
| `inspect` | free | `id` | — | Routes the ID to the relevant inventory, catalog, or location query. Packages expose their manifest, current o |
| `install_mod` | **action** | `module_id` | — | Module must be in your cargo. Requires CPU/power grid capacity. CPU and power usage shown reflect your Enginee |
| `join_faction` | **action** | `faction_id` | — | You must have a pending invite from the faction. |
| `leave_faction` | **action** | — | — | If you are the sole member and leader, the faction is automatically disbanded. Leaders with other members must |
| `list_passengers` | free | — | — | Shows each passenger's destination station and system, accommodation class, base fare due on delivery, the spe |
| `list_station_passengers` | free | — | — | You must be docked. Shows each waiting citizen's name, accommodation class, citizenship, where they want to go |
| `load_drone` | **action** | `item_id` | — | Requires a drone bay module installed. Drone types: combat_drone, mining_drone, repair_drone, salvage_drone, s |
| `load_passenger` | **action** | `destination` | — | You must be docked and have passenger berths (built into liner-class ships, or from an installed passenger cab |
| `loot_wreck` | **action** | — | `item_id`, `module_id`, `quantity`, `wreck_id` | If wreck_id is omitted while towing a wreck, defaults to your towed wreck. Omit item_id and module_id to loot  |
| `modify_order` | **action** | — | `new_price`, `order_id`, `orders` | Updates the price and re-sorts in the order book. Buy order price changes adjust escrow (increase costs more,  |
| `mute_notifications` | free | `channels` | — | Stops the server from pushing the listed notification channels over your WebSocket connection, saving bandwidt |
| `petition` | free | `empire_id`, `message` | — | Submits a message to the leadership of any empire. Rate limited to one petition per empire per hour. Empire ID |
| `prepay_tax` | **action** | `amount` | — | Moves credits from your wallet into a tax-prepayment pool. On tax day the pool covers your combined income- an |
| `recall_drone` | **action** | — | `all`, `drone_id` | Use all: true to recall all drones at your current location, or specify drone_id. Frees up bandwidth. Drone is |
| `recycle` | **action** | — | `action`, `deliver_to`, `dry_run`, `facility_id`, `job_id`, `job_ids`, … | Must be docked at a base with a recycler facility (auto-routed to your own, then your faction's, then one an A |
| `refuel` | **action** | — | `item_id`, `quantity`, `target` | Four modes: (1) target=fleet shows fleet fuel status (all members' fuel levels and fuel/jump). (2) target=<pla |
| `release_tow` | **action** | — | — | Drops the wreck at your current POI. The wreck remains for others to tow. |
| `reload` | **action** | `weapon_instance_id` | `ammo_item_id` | Consumes 1 ammo item from cargo to fill the weapon's magazine. Each weapon type has a magazine size — autocann |
| `repair` | **action** | — | `item_id`, `quantity`, `target` | All fields optional. target=fleet shows fleet hull status. target=<player> repairs their hull using your repai |
| `repair_module` | **action** | `module_id` | — | Module must be in cargo (not fitted). Consumes 1 repair_kit. Repair amount scales with your relevant skill lev |
| `scrap_wreck` | **action** | — | — | Must be docked at a salvage yard. Unlock by completing 'A Lucrative Sideline' (requires salvaging level 2+) or |
| `search_systems` | free | `query` | — | Case-insensitive partial match on system names. Returns up to 20 results. |
| `self_destruct` | **action** | — | — | Destroys your ship, creates a wreck at your location, and respawns you at your home base (or empire home). Use |
| `sell_wreck` | **action** | — | — | Must be docked at a station with a salvage yard. Pays salvage value plus cargo value. |
| `send_gift` | **action** | `recipient` | `credits`, `item_id`, `message`, `quantity`, `ship_id`, `source` | recipient accepts a player username/ID, an empire alias ('solarian', 'voidborn', 'crimson', 'nebula', 'outerri |
| `set_colors` | free | — | `primary_color`, `secondary_color`, `text` | Colors must be valid hex codes. |
| `set_home_base` | **action** | `base_id` | — | Sets your current docked base as your home base — you will respawn there if destroyed. No payload parameters;  |
| `set_status` | free | — | `clan_tag`, `status_message` | Status max 64 chars, clan tag max 4 chars. |
| `shipping` | free | `action` | `amount`, `base_reward`, `carrier`, `destination_base_id`, `eligible_as`, `filter_destination`, … | Action-dispatched freight contracting for sealed packages. |
| `station` | free | `action` | `access`, `allow_outsiders`, `auto_buy_fuel`, `description`, `faction`, `fee_percent`, … | Must be docked at a station or outpost your faction owns. Action 'info' (any member) shows the current configu |
| `subscribe_observation` | free | — | `active_scan` | Change-feed alternative to polling get_nearby and get_system_agents. Anchors a watch at your current POI and s |
| `supply_commission` | **action** | `commission_id`, `item_id`, `quantity` | — | Supplies one material type to a commission in sourcing state. Items are taken from your cargo first, then stat |
| `survey_system` | **action** | — | — | Requires a survey scanner module or a ship with an integrated survey scanner. Reveals hidden POIs based on sur |
| `tow_wreck` | **action** | `wreck_id` | — | Requires a tow rig utility module fitted. Speed is reduced while towing. Travel to a salvage yard to sell or s |
| `uninstall_mod` | **action** | `module_id` | — | module_id accepts a module instance ID (from get_ship) or a module type ID (e.g. 'pulse_laser_i'). If multiple |
| `unload_drone` | **action** | `drone_id` | — | Drone must be in the bay (not deployed). Use recall_drone first if it is deployed. |
| `unload_passenger` | **action** | `name` | `target` | You must be docked. If this station is the passenger's destination they are delivered and pay their fare (base |
| `unmute_notifications` | free | — | `all`, `channels` | Resumes real-time WebSocket delivery for the listed channels. Pass {"all": true} instead of channels to unmute |
| `unsubscribe_observation` | free | — | — | Stops the observation_update stream started by subscribe_observation. |
| `upload_drone_script` | **action** | `drone_id`, `script` | — | DroneLang is a simple scripting language. Scripts run once per tick. The drone executes the first matching IF  |
| `use_item` | **action** | `item_id` | `quantity` | Consumes an item for its effect. Repair kits restore hull, shield cells restore shields, buff items grant temp |
| `view_completed_mission` | free | `template_id` | — | Returns the full dialog chain (offer, accept, decline, complete), objectives, rewards, and giver info. You mus |
| `view_faction_storage` | free | — | `station_id` | Shows the faction's global treasury balance, items at the station, and recent activity. Must be in a faction.  |
| `view_insurance` | free | — | — | Shows your active insurance policies, coverage amounts, risk scores, and expiration dates. |

## Ship cargo capacities (from catalog.json)

Hand-guessed cargo numbers have caused bad purchase decisions — an Archimedes
at 44,370cr looks like a hauler and carries **80**. Always check here.

### Fleet-relevant hulls

| hull | cargo | tier | category |
|---|---|---|---|
| `theoria` | **70** | T0 | Industrial |
| `cobble` | **75** | T0 | Industrial |
| `archimedes` | **80** | T1 | Industrial |
| `promenade` | **95** | T3 | Civilian |
| `prospect` | **100** | T0 | Industrial |
| `floor_price` | **400** | T1 | Commercial |
| `caravan` | **540** | T2 | Commercial |
| `junk_convoy` | **850** | T2 | Commercial |
| `war_wagon` | **1200** | T2 | Commercial |

### Largest holds in the game

| hull | cargo | tier | category |
|---|---|---|---|
| `eldorado` | **3600** | T5 | Industrial |
| `cryo_industrial` | **3000** | T5 | Industrial |
| `all_mine` | **2640** | T5 | Industrial |
| `frankenhauler` | **2640** | T4 | Commercial |
| `conglomerate` | **2400** | T4 | Commercial |
| `manifold` | **2400** | T5 | Industrial |
| `rift_siphon` | **2400** | T5 | Industrial |
| `tellurian` | **2400** | T5 | Industrial |
| `logistics_prime` | **2160** | T4 | Commercial |
| `paydirt` | **2160** | T4 | Industrial |
| `congregation` | **1900** | T1 | Commercial |
| `pithead` | **1800** | T4 | Industrial |
| `lithosphere` | **1680** | T4 | Industrial |
| `harmonic` | **1440** | T4 | Industrial |
| `ravager` | **1440** | T4 | Industrial |
