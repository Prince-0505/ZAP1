/* ============================================================
 * TildaBite — Live Supabase Integration Layer
 * ONE file used by all 3 dashboards:
 *   - customer_app.html
 *   - admin_dashboard.html
 *   - rider_dashboard.html
 *
 * It auto-detects which page it's running in, replaces local
 * mock data with live Supabase reads/writes, and wires realtime
 * so an order placed on the customer phone shows up in the
 * admin laptop instantly (and vice-versa).
 * ============================================================ */

/* ── CONFIG ────────────────────────────────────────────────── */
const SUPABASE_URL  = 'https://xxqctsfrnynrfoldnahw.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4cWN0c2ZybnlucmZvbGRuYWh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MTU5NjgsImV4cCI6MjA5NzM5MTk2OH0.9NbsyMz0Hfkb1KFbvStn6hUMRtRw9RJd9FTuiHOpsG8';

const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);
window.sb = sb;

/* ── small helpers ────────────────────────────────────────── */
function _toast(msg){
  if (typeof window.showToast === 'function') return window.showToast(msg);
  if (typeof window.toast === 'function')      return window.toast(msg);
  console.log('[toast]', msg);
}
function _safe(fn){ if (typeof fn === 'function') try{ fn(); }catch(e){ console.error(e); } }
function _detectPage(){
  const t = (document.title || '').toLowerCase();
  if (t.includes('admin'))  return 'admin';
  if (t.includes('rider'))  return 'rider';
  return 'customer';
}

/* ===========================================================
 * CUSTOMER APP
 * =========================================================== */
async function customerLoadMenu(){
  const { data, error } = await sb.from('menu_items')
    .select('*').eq('is_active', true).order('id');
  if (error){ console.error(error); return; }
  window.MENU = data.map(m => ({
    id: m.id, name: m.name, desc: m.description || '',
    price: m.price, emoji: m.emoji || '🍽️',
    cat: m.category, veg: m.is_veg,
    img: m.image_url || '',
    oos: m.is_out_of_stock,
    bestseller: m.is_bestseller
  }));
  _safe(() => window.renderMenu(window.MENU));
}

async function customerLoadOrders(){
  const { data: { user } } = await sb.auth.getUser();
  if (!user){ window.SAMPLE_ORDERS = []; _safe(window.renderOrders); return; }
  const { data, error } = await sb.from('orders')
    .select('*').eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error){ console.error(error); return; }
  window.SAMPLE_ORDERS = (data || []).map(o => ({
    id: o.id,
    date: new Date(o.created_at).toLocaleDateString('en-IN'),
    status: o.status,
    items: (o.items || []).map(i => `${i.name} ×${i.qty}`),
    total: o.total,
    otp: o.delivery_otp,
    rider: o.rider_name
  }));
  _safe(window.renderOrders);
}

async function customerPlaceOrder(){
  const cart = window.cart || {};
  const MENU = window.MENU || [];
  const keys = Object.keys(cart).filter(k => cart[k] > 0);
  if (!keys.length) return _toast('Your cart is empty');

  const { data: { user } } = await sb.auth.getUser();
  if (!user) return _toast('Please sign in first');

  const items = keys.map(k => {
    const it = MENU.find(m => String(m.id) === String(k));
    return { id: it.id, name: it.name, qty: cart[k], price: it.price };
  });
  const sub = items.reduce((s,i) => s + i.price * i.qty, 0);
  const MIN_ORDER = 99;
  if (sub < MIN_ORDER) return _toast(`Minimum order ₹${MIN_ORDER}. Add ₹${MIN_ORDER - sub} more`);

  const addr = (document.getElementById('checkout-address')?.value
             || document.getElementById('address')?.value
             || 'Delivery address pending').trim();
  const pay  = document.querySelector('input[name="pay"]:checked')?.value
             || document.getElementById('pay-method')?.value
             || 'razorpay';
  const tax  = Math.round(sub * 0.05);
  const otp  = String(Math.floor(1000 + Math.random() * 9000));

  // grab profile for customer_name / phone
  const { data: prof } = await sb.from('profiles').select('full_name,phone').eq('id', user.id).maybeSingle();

  const { data, error } = await sb.from('orders').insert({
    user_id:          user.id,
    customer_name:    prof?.full_name || user.email,
    customer_phone:   prof?.phone     || '',
    delivery_address: addr,
    items, subtotal: sub, tax, total: sub + tax,
    payment_method:   pay,
    delivery_otp:     otp,
    status:           'pending'
  }).select().single();

  if (error) return _toast('❌ ' + error.message);

  _toast(`Order ${data.id} placed! OTP: ${otp}`);
  window.cart = {};
  _safe(window.updateCartUI);
  await customerLoadOrders();
  if (typeof window.showView === 'function') window.showView('orders');
}

function customerRealtime(userId){
  sb.channel('cust-orders-' + userId)
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `user_id=eq.${userId}` },
        payload => {
          if (payload.eventType === 'UPDATE' && payload.new?.status) {
            _toast(`Order ${payload.new.id}: ${payload.new.status}`);
          }
          customerLoadOrders();
        })
    .subscribe();
  sb.channel('cust-menu')
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'menu_items' },
        () => customerLoadMenu())
    .subscribe();
}

async function customerBootstrap(){
  // override the in-page handlers
  window.placeOrder    = customerPlaceOrder;
  window.loadSharedMenu = customerLoadMenu;  // some buttons call this
  // initial loads
  await customerLoadMenu();
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user){
    await customerLoadOrders();
    customerRealtime(session.user.id);
  }
  sb.auth.onAuthStateChange(async (_e, s) => {
    if (s?.user){ await customerLoadOrders(); customerRealtime(s.user.id); }
    else        { window.SAMPLE_ORDERS = []; _safe(window.renderOrders); }
  });
}

/* ===========================================================
 * ADMIN DASHBOARD
 * =========================================================== */
async function adminLoadOrders(){
  const { data, error } = await sb.from('orders')
    .select('*').order('created_at', { ascending: false });
  if (error){ console.error(error); return; }
  window.ORDERS = (data || []).map(o => ({
    id: o.id,
    customer: o.customer_name || '—',
    phone:    o.customer_phone || '',
    address:  o.delivery_address,
    time:     new Date(o.created_at).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }),
    amount:   o.total,
    status:   o.status,
    rider:    o.rider_name || null,
    rider_id: o.rider_id   || null,
    items:    (o.items || []).map(i => `${i.name} ×${i.qty}`).join(', '),
    otp:      o.delivery_otp
  }));
  _safe(window.renderAllOrders);
  _safe(window.renderRecentOrders);
  _safe(window.updateOverviewStats);
}

async function adminLoadRiders(){
  const { data, error } = await sb.from('riders').select('*').order('name');
  if (error){ console.error(error); return; }

  // active-order count per rider (from in-flight orders)
  const active = {};
  (window.ORDERS || []).forEach(o => {
    if (o.rider_id && ['otw','preparing'].includes(o.status))
      active[o.rider_id] = (active[o.rider_id] || 0) + 1;
  });

  window.RIDERS = (data || []).map(r => ({
    id: r.id, name: r.name, phone: r.phone,
    status: r.status, rating: r.rating,
    deliveries: r.total_deliveries,
    orders: active[r.id] || 0
  }));
  _safe(window.renderRiders);
}

async function adminLoadMenu(){
  const { data, error } = await sb.from('menu_items').select('*').order('id');
  if (error){ console.error(error); return; }
  window.MENU_ITEMS = (data || []).map(m => ({
    id: m.id, name: m.name, cat: m.category, price: m.price,
    active: m.is_active, stock: m.stock_qty, sold: m.sold_count,
    bestseller: m.is_bestseller, emoji: m.emoji
  }));
  _safe(window.renderMenuMgmt);
}

async function adminLoadNotifications(){
  const { data } = await sb.from('notifications')
    .select('*').order('created_at', { ascending: false }).limit(20);
  window.notifLog = (data || []).map(n => ({
    type: n.type, title: n.title, msg: n.message,
    time: new Date(n.created_at).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }),
    target: n.target
  }));
  _safe(window.renderNotifLog);
}

async function adminAssignRider(orderId, riderId){
  const rider = (window.RIDERS || []).find(r => r.id === riderId);
  const otp   = String(Math.floor(1000 + Math.random() * 9000));
  const { error } = await sb.from('orders').update({
    rider_id: riderId, rider_name: rider?.name || null,
    status: 'otw', delivery_otp: otp
  }).eq('id', orderId);
  if (error) return _toast('❌ ' + error.message);
  await sb.from('riders').update({ status: 'busy' }).eq('id', riderId);
  _toast(`Rider ${rider?.name} assigned · OTP ${otp}`);
}

async function adminSendNotification(){
  const title  = document.getElementById('notif-title')?.value.trim();
  const msg    = document.getElementById('notif-msg')?.value.trim();
  const target = document.getElementById('notif-target')?.value || 'all_customers';
  if (!title || !msg) return _toast('Fill in title and message');
  const { error } = await sb.from('notifications').insert({ type:'order', title, message: msg, target });
  if (error) return _toast('❌ ' + error.message);
  document.getElementById('notif-title').value = '';
  document.getElementById('notif-msg').value   = '';
  _toast('Notification sent');
}

async function adminToggleMenuItem(id, active){
  const { error } = await sb.from('menu_items').update({ is_active: !active }).eq('id', id);
  if (error) return _toast('❌ ' + error.message);
}

function adminRealtime(){
  sb.channel('adm-orders')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' },
        () => { adminLoadOrders().then(adminLoadRiders); })
    .subscribe();
  sb.channel('adm-riders')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'riders' },
        () => adminLoadRiders())
    .subscribe();
  sb.channel('adm-menu')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items' },
        () => adminLoadMenu())
    .subscribe();
  sb.channel('adm-notif')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' },
        () => adminLoadNotifications())
    .subscribe();
}

async function adminBootstrap(){
  // override anything the static HTML defines
  window.adminRefreshOrders = adminLoadOrders;
  window.assignRider        = adminAssignRider;
  window.sendNotification   = adminSendNotification;
  window.toggleMenuItem     = adminToggleMenuItem;

  await adminLoadOrders();
  await adminLoadRiders();
  await adminLoadMenu();
  await adminLoadNotifications();
  adminRealtime();
}

/* ===========================================================
 * RIDER DASHBOARD
 * =========================================================== */
async function riderResolveSelf(){
  // Riders pick themselves from the in-page selector (id="rider-select")
  // or auto-bind to the first rider for demo convenience.
  const sel = document.getElementById('rider-select');
  let id = sel?.value || localStorage.getItem('tildabite_rider_id');
  if (!id){
    const { data } = await sb.from('riders').select('id,name').order('name').limit(1);
    id = data?.[0]?.id;
  }
  if (id) localStorage.setItem('tildabite_rider_id', id);
  return id;
}

async function riderLoadData(){
  const riderId = await riderResolveSelf();
  if (!riderId){ _toast('No rider configured'); return; }
  window.RIDER_ID = riderId;

  // active order
  const { data: active } = await sb.from('orders')
    .select('*').eq('rider_id', riderId)
    .in('status', ['otw','preparing'])
    .order('updated_at', { ascending: false })
    .limit(1).maybeSingle();

  window.order = active ? {
    id: active.id,
    customer: active.customer_name || '—',
    phone: active.customer_phone || '',
    items: (active.items || []).map(i => `${i.name} ×${i.qty}`).join(', '),
    amount: active.total,
    address: active.delivery_address,
    otp: active.delivery_otp,
    stage: active.status === 'otw' ? 'otw' : 'assigned'
  } : null;
  _safe(window.renderActive);

  // delivery history
  const { data: hist } = await sb.from('orders')
    .select('id, customer_name, total, updated_at')
    .eq('rider_id', riderId).eq('status', 'delivered')
    .order('updated_at', { ascending: false }).limit(10);

  window.history = (hist || []).map(h => ({
    id: h.id, customer: h.customer_name || '—',
    amount: h.total, status: 'delivered'
  }));
  _safe(window.renderHistory);
}

async function riderVerifyOtp(){
  const entered = (document.getElementById('otp-input')?.value || '').trim();
  const o = window.order;
  if (!o) return _toast('No active order');
  if (entered !== o.otp) return _toast('Incorrect OTP');
  await sb.from('orders').update({ status:'delivered', otp_verified:true }).eq('id', o.id);
  await sb.from('riders').update({ status:'available' }).eq('id', window.RIDER_ID);
  _toast('Delivered ✅');
  if (typeof window.closeOtp === 'function') window.closeOtp();
  await riderLoadData();
}

async function riderSetStatus(newStatus){
  if (!window.RIDER_ID) return;
  await sb.from('riders').update({ status: newStatus }).eq('id', window.RIDER_ID);
  _toast('Status: ' + newStatus);
}

function riderRealtime(){
  const id = window.RIDER_ID;
  if (!id) return;
  sb.channel('rdr-' + id)
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `rider_id=eq.${id}` },
        () => { _toast('Order update 🛵'); riderLoadData(); })
    .subscribe();
}

async function riderBootstrap(){
  // populate rider picker so the demo can swap riders quickly
  const sel = document.getElementById('rider-select');
  if (sel){
    const { data } = await sb.from('riders').select('id,name').order('name');
    sel.innerHTML = (data || []).map(r => `<option value="${r.id}">${r.name}</option>`).join('');
    const saved = localStorage.getItem('tildabite_rider_id');
    if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
    sel.addEventListener('change', async () => {
      localStorage.setItem('tildabite_rider_id', sel.value);
      await riderLoadData(); riderRealtime();
    });
  }

  window.loadRiderData = riderLoadData;
  window.verifyOtp     = riderVerifyOtp;
  window.setRiderStatus = riderSetStatus;

  await riderLoadData();
  riderRealtime();
}

/* ===========================================================
 * AUTH (shared, customer-focused)
 * =========================================================== */
window.tbAuth = {
  signUp: async (email, password, full_name, phone) => {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { full_name } }
    });
    if (error){ _toast('❌ ' + error.message); return null; }
    if (data.user) {
      await sb.from('profiles').update({ phone, full_name }).eq('id', data.user.id);
    }
    _toast('Account created 🎉');
    return data;
  },
  signIn: async (email, password) => {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error){ _toast('❌ ' + error.message); return false; }
    _toast('Signed in');
    return true;
  },
  signOut: async () => { await sb.auth.signOut(); _toast('Signed out'); },
  resetPassword: async (email) => {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/reset-password.html'
    });
    if (error) return _toast('❌ ' + error.message);
    _toast('Reset link sent 📧');
  }
};

/* ===========================================================
 * AUTO-BOOTSTRAP
 * =========================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const page = _detectPage();
  window.__tbPage = page;
  console.log('[TildaBite] page =', page);
  if (page === 'admin')    return adminBootstrap();
  if (page === 'rider')    return riderBootstrap();
  return customerBootstrap();
});
