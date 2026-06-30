// ============================================================
// TildaBite / ZapFood — LIVE SYNC BRIDGE
// One file shared by customer_app.html, admin_dashboard.html,
// and rider_dashboard.html. Hydrates localStorage from Supabase
// on boot, mirrors every local write back to the database, and
// pushes real-time updates from other devices straight into the
// UI — no other code changes needed in the HTML files.
//
// Order from phone → instantly visible on admin computer.
// Admin assigns rider → instantly visible on rider phone.
// Rider confirms delivery → instantly visible on customer phone.
// ============================================================

// ─── CONFIG ──────────────────────────────────────────────────
const SUPABASE_URL  = 'https://pscefvrmdjtjjhnbahga.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzY2VmdnJtZGp0ampobmJhaGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MDkzNTIsImV4cCI6MjA5ODM4NTM1Mn0.867dQZQqeMHw9SUEBBiRNfACwBUKFx6TD1tdKj_-gc8';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);
window.sb = sb;

// ─── APP DETECTION ───────────────────────────────────────────
const APP =
  document.getElementById('admin-shell')  ? 'admin'  :
  document.getElementById('rider-main')   ? 'rider'  :
                                            'customer';
console.log('[TildaBite bridge] running as', APP);

const ORDERS_KEY = 'tildabite_orders';
const MENU_KEY   = 'tildabite_menu';

// Native setItem reference — we use this to write WITHOUT triggering our push
const _origSetItem = Storage.prototype.setItem;
let _suppress = false;
function lsSet(k, v){ _suppress = true; _origSetItem.call(localStorage, k, v); _suppress = false; }

// Snapshots used for diffing — what was the last state we know about?
let _lastOrders = '[]';
let _lastMenu   = '[]';

// ─── SHAPE MAPPERS ───────────────────────────────────────────
function dbToLsOrder(o){
  const created = o.created_at ? new Date(o.created_at) : new Date();
  return {
    id:             o.id,
    userId:         o.customer_email || '',
    customer:       o.customer_name  || 'Guest',
    customer_phone: o.customer_phone || '—',
    date:           created.toLocaleDateString('en-IN'),
    time:           created.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}),
    items:          Array.isArray(o.items) ? o.items.map(i => `${i.name} ×${i.qty}`) : [],
    address:        o.delivery_address || '—',
    subtotal:       o.subtotal || 0,
    tax:            o.tax || 0,
    total:          o.total || 0,
    otp:            o.delivery_otp || null,
    otp_verified:   !!o.otp_verified,
    status:         o.status || 'pending',
    rider_id:       o.rider_id || null,
    rider:          o.rider_name || null,
  };
}

function lsToDbOrder(o, menuCache){
  const items = (o.items || []).map(s => {
    const m = String(s).match(/^(.*) ×(\d+)$/);
    if(!m) return null;
    const name = m[1], qty = parseInt(m[2], 10);
    const mi = menuCache.find(x => x.name === name);
    return { id: mi ? mi.id : null, name, qty, price: mi ? mi.price : 0 };
  }).filter(Boolean);
  return {
    id:               o.id,
    customer_email:   o.userId || null,
    customer_name:    o.customer || 'Guest',
    customer_phone:   o.customer_phone && o.customer_phone !== '—' ? o.customer_phone : null,
    delivery_address: o.address || 'N/A',
    items,
    subtotal:         o.subtotal || 0,
    tax:              o.tax || 0,
    total:            o.total || 0,
    delivery_otp:     o.otp || null,
    otp_verified:     !!o.otp_verified,
    status:           o.status || 'pending',
    rider_id:         o.rider_id || null,
    rider_name:       o.rider || null,
  };
}

function dbToLsMenu(m){
  return {
    id: m.id, name: m.name, desc: m.description || '', price: m.price,
    cat: m.category, emoji: m.emoji || '🍽️', veg: !!m.is_veg,
    image: m.image_url || '',
    stock: (m.stock_qty === null || m.stock_qty === undefined) ? null : m.stock_qty,
    oos: !!m.is_out_of_stock, bestseller: !!m.is_bestseller,
    sold: m.sold_count || 0, active: m.is_active !== false,
  };
}

function lsToDbMenu(m){
  return {
    id: m.id, name: m.name, description: m.desc || '', price: m.price || 0,
    category: m.cat || 'snacks', emoji: m.emoji || '🍽️', is_veg: !!m.veg,
    image_url: m.image || null,
    stock_qty: typeof m.stock === 'number' ? m.stock : null,
    is_out_of_stock: !!m.oos, is_bestseller: !!m.bestseller,
    sold_count: m.sold || 0, is_active: m.active !== false,
  };
}

// ─── RENDER TRIGGER (per-app) ────────────────────────────────
function triggerRender(which){
  try {
    if (APP === 'admin') {
      if (typeof adminRefreshOrders === 'function') adminRefreshOrders();
      if (which !== 'orders' && typeof renderMenuMgmt === 'function'
          && document.getElementById('view-menu-mgmt')?.classList.contains('active')) {
        renderMenuMgmt();
      }
    } else if (APP === 'rider') {
      if (typeof loadRiderData === 'function') loadRiderData();
    } else { // customer
      if (typeof renderOrders === 'function') renderOrders();
      if (which !== 'orders') {
        if (typeof loadSharedMenu === 'function') loadSharedMenu();
        if (typeof applyFilters === 'function') {
          const q = (document.getElementById('search-input')?.value || '').toLowerCase();
          applyFilters(q);
        }
      }
    }
  } catch(e){ console.warn('[bridge] render error', e); }
}

// ─── INITIAL HYDRATION ───────────────────────────────────────
async function hydrate(){
  const [oRes, mRes] = await Promise.all([
    sb.from('orders').select('*').order('created_at', { ascending: false }),
    sb.from('menu_items').select('*').order('id'),
  ]);
  if (oRes.error) console.error('[bridge] orders load', oRes.error);
  if (mRes.error) console.error('[bridge] menu load',   mRes.error);

  const orders = (oRes.data || []).map(dbToLsOrder);
  const menu   = (mRes.data || []).map(dbToLsMenu);

  lsSet(MENU_KEY,   JSON.stringify(menu));    // menu first (orders may reference items)
  lsSet(ORDERS_KEY, JSON.stringify(orders));
  _lastOrders = JSON.stringify(orders);
  _lastMenu   = JSON.stringify(menu);

  triggerRender();
}

// ─── DIFF + PUSH ON LOCAL WRITES ─────────────────────────────
Storage.prototype.setItem = function(k, v){
  _origSetItem.call(this, k, v);
  if (_suppress) return;
  if (this !== window.localStorage) return;
  if (k === ORDERS_KEY) pushOrdersDiff(safeParse(v, []));
  if (k === MENU_KEY)   pushMenuDiff  (safeParse(v, []));
};

function safeParse(s, fb){ try { return JSON.parse(s); } catch(e){ return fb; } }

async function pushOrdersDiff(curr){
  const prev = safeParse(_lastOrders, []);
  const prevById = new Map(prev.map(o => [o.id, o]));
  const menuCache = safeParse(localStorage.getItem(MENU_KEY) || '[]', []);

  for (const o of curr) {
    const p = prevById.get(o.id);
    if (!p) {
      // INSERT new order
      const row = lsToDbOrder(o, menuCache);
      const { error } = await sb.from('orders').insert(row);
      if (error) console.error('[bridge] order insert', error, row);
    } else if (JSON.stringify(p) !== JSON.stringify(o)) {
      // UPDATE changed fields (skip items — never edited locally after creation)
      const row = lsToDbOrder(o, menuCache);
      delete row.id; delete row.items;
      const { error } = await sb.from('orders').update(row).eq('id', o.id);
      if (error) console.error('[bridge] order update', error, row);
    }
  }
  _lastOrders = JSON.stringify(curr);
}

async function pushMenuDiff(curr){
  const prev = safeParse(_lastMenu, []);
  const prevById = new Map(prev.map(m => [m.id, m]));
  const currIds  = new Set(curr.map(m => m.id));

  // deletes
  for (const p of prev) {
    if (!currIds.has(p.id)) {
      const { error } = await sb.from('menu_items').delete().eq('id', p.id);
      if (error) console.error('[bridge] menu delete', error);
    }
  }
  // inserts / updates
  for (const m of curr) {
    const p = prevById.get(m.id);
    if (!p) {
      const { error } = await sb.from('menu_items').upsert(lsToDbMenu(m));
      if (error) console.error('[bridge] menu insert', error);
    } else if (JSON.stringify(p) !== JSON.stringify(m)) {
      const row = lsToDbMenu(m); delete row.id;
      const { error } = await sb.from('menu_items').update(row).eq('id', m.id);
      if (error) console.error('[bridge] menu update', error);
    }
  }
  _lastMenu = JSON.stringify(curr);
}

// ─── REALTIME → LOCAL ────────────────────────────────────────
let _refreshOrdersTimer, _refreshMenuTimer;
async function refreshOrdersFromDb(){
  const { data, error } = await sb.from('orders').select('*').order('created_at',{ascending:false});
  if (error) return console.error('[bridge] realtime orders', error);
  const arr = (data || []).map(dbToLsOrder);
  lsSet(ORDERS_KEY, JSON.stringify(arr));
  _lastOrders = JSON.stringify(arr);
  triggerRender('orders');
}
async function refreshMenuFromDb(){
  const { data, error } = await sb.from('menu_items').select('*').order('id');
  if (error) return console.error('[bridge] realtime menu', error);
  const arr = (data || []).map(dbToLsMenu);
  lsSet(MENU_KEY, JSON.stringify(arr));
  _lastMenu = JSON.stringify(arr);
  triggerRender('menu');
}
// Debounced wrappers — batch bursts of changes into a single refresh
function scheduleOrdersRefresh(){ clearTimeout(_refreshOrdersTimer); _refreshOrdersTimer = setTimeout(refreshOrdersFromDb, 250); }
function scheduleMenuRefresh()  { clearTimeout(_refreshMenuTimer);   _refreshMenuTimer   = setTimeout(refreshMenuFromDb,   250); }

function startRealtime(){
  sb.channel('tb-orders')
    .on('postgres_changes', { event:'*', schema:'public', table:'orders'     }, scheduleOrdersRefresh)
    .subscribe();
  sb.channel('tb-menu')
    .on('postgres_changes', { event:'*', schema:'public', table:'menu_items' }, scheduleMenuRefresh)
    .subscribe();
}

// ─── BOOT ────────────────────────────────────────────────────
(async () => {
  try {
    await hydrate();
  } catch(e){ console.error('[bridge] hydrate failed', e); }
  startRealtime();

  // Safety net: poll every 8s in case realtime drops (mobile sleep, etc.)
  setInterval(refreshOrdersFromDb, 8000);
})();

// Expose a manual refresh helper for debugging
window.tildabiteRefresh = async () => { await refreshMenuFromDb(); await refreshOrdersFromDb(); };
