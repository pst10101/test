// 공통 코드: 설정 읽기, 혼잡도 계산, Firebase 또는 예시 데이터 연결
// (보통은 고칠 필요 없어요. 설정은 config.js에서 바꾸세요.)
(function () {
  "use strict";

  var C = window.APP_CONFIG || {};
  var COUNTER = Object.assign({ intervalSec: 5, minScore: 0.5, heartbeatSec: 60, refreshMin: 5 }, C.counter || {});
  // config.js에 적은 기본 교실 목록. 관리 화면에서 추가·삭제한 내용은 아래 mergeAll()이 겹쳐서 보여줘요.
  var rooms = (C.rooms || []).map(function (r) {
    return Object.assign({ normalAt: 8, busyAt: 16, desc: "", hours: "", title: "" }, r);
  });
  var baseById = {};
  rooms.forEach(function (r) { baseById[r.id] = r; });
  var fb = C.firebase || {};
  var demo = !(fb.apiKey && fb.projectId);

  var LEVELS = [
    { key: "free", label: "여유" },
    { key: "normal", label: "보통" },
    { key: "busy", label: "혼잡" }
  ];

  // 전자칠판: 이 시간 넘게 소식이 없으면 '정보 없음'
  var STALE_MS = COUNTER.refreshMin * 60000 * 2 + 120000;
  // 관리 화면: 이 시간 넘게 신호가 없으면 '꺼짐'
  var OFFLINE_MS = Math.max(COUNTER.heartbeatSec * 3000, 120000);

  function room(id) {
    for (var i = 0; i < rooms.length; i++) if (rooms[i].id === id) return rooms[i];
    return null;
  }

  // list를 넘기면 그 목록 기준, 안 넘기면 config.js 기본 목록 기준
  function floors(list) {
    var seen = {};
    (list || rooms).forEach(function (r) { seen[r.floor] = true; });
    return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
  }

  function grades(list) {
    var seen = {};
    (list || rooms).forEach(function (r) { if (r.grade != null) seen[r.grade] = true; });
    return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  }

  // 관리 화면에서 고칠 수 있는 항목
  var EDITABLE = ["title", "desc", "hours", "normalAt", "busyAt", "name", "grade", "floor"];
  var NUMERIC = { normalAt: 1, busyAt: 1, grade: 1, floor: 1 };

  function validField(k, v) {
    if (v === undefined || v === null) return false;
    if (NUMERIC[k]) return typeof v === "number" && isFinite(v);
    if (k === "name") return typeof v === "string" && v.replace(/\s/g, "") !== "";
    return true;
  }

  function mergeRoom(base, remote) {
    var r = Object.assign({}, base);
    if (remote) {
      EDITABLE.forEach(function (k) {
        if (validField(k, remote[k])) r[k] = remote[k];
      });
      if (remote.editedAt) r.editedAt = remote.editedAt;
    }
    return r;
  }

  function byId(a, b) {
    return String(a.id).localeCompare(String(b.id), "ko", { numeric: true });
  }

  function isRemoved(m) { return !!m && m.removed === true; }

  // 관리 화면에서 새로 만든 교실 (config.js에 없는 것)
  function customRoom(id, m) {
    if (!m || m.custom !== true || !validField("name", m.name) || !validField("floor", m.floor)) return null;
    var base = { id: id, custom: true, grade: null, title: "", desc: "", hours: "", normalAt: 8, busyAt: 16 };
    return mergeRoom(base, m);
  }

  // 전자칠판에 보여줄 최종 교실 목록:
  //  config.js 기본 목록 (삭제 표시된 것은 뺌) + 관리 화면에서 추가한 교실 (id 순서로 뒤에 붙임)
  function mergeAll(map) {
    map = map || {};
    var out = [], extra = [];
    rooms.forEach(function (r) {
      if (isRemoved(map[r.id])) return;
      out.push(mergeRoom(r, map[r.id]));
    });
    Object.keys(map).forEach(function (id) {
      if (baseById[id] || isRemoved(map[id])) return;
      var r = customRoom(id, map[id]);
      if (r) extra.push(r);
    });
    extra.sort(byId);
    return out.concat(extra);
  }

  // 삭제 표시된 교실 (되살릴 수 있어요)
  function removedRooms(map) {
    map = map || {};
    var out = [], extra = [];
    rooms.forEach(function (r) {
      if (isRemoved(map[r.id])) out.push(mergeRoom(r, map[r.id]));
    });
    Object.keys(map).forEach(function (id) {
      if (baseById[id] || !isRemoved(map[id])) return;
      var r = customRoom(id, map[id]);
      if (r) extra.push(r);
    });
    extra.sort(byId);
    return out.concat(extra);
  }

  // 학년·반 번호로 교실 id 만들기 (예: 2학년 3반 → "2-3")
  function makeId(grade, cls) { return grade + "-" + cls; }

  function levelFromCount(r, n) {
    if (n >= r.busyAt) return 2;
    if (n >= r.normalAt) return 1;
    return 0;
  }

  function isLevel(v) { return v === 0 || v === 1 || v === 2; }

  // 전자칠판에 보여줄 최종 상태
  function effective(st, now) {
    now = now || Date.now();
    if (!st) return { level: null, source: "none", at: 0 };
    if (isLevel(st.override)) return { level: st.override, source: "override", at: st.overrideAt || 0 };
    if (isLevel(st.level) && st.updatedAt && now - st.updatedAt < STALE_MS) {
      return { level: st.level, source: "auto", at: st.updatedAt, count: st.count };
    }
    return { level: null, source: st.updatedAt ? "stale" : "none", at: st.updatedAt || 0 };
  }

  function levelKey(l) { return isLevel(l) ? LEVELS[l].key : "none"; }
  function levelLabel(l) { return isLevel(l) ? LEVELS[l].label : "정보 없음"; }

  function ago(ms, now) {
    if (!ms) return "기록 없음";
    now = now || Date.now();
    var s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 15) return "방금";
    if (s < 60) return s + "초 전";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "분 전";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "시간 전";
    return Math.floor(h / 24) + "일 전";
  }

  function clock(ms) {
    if (!ms) return "–";
    return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- 스크립트 불러오기 ----------
  function loadScript(src, ms) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      var timer = setTimeout(function () { s.remove(); reject(new Error("timeout")); }, ms || 20000);
      s.src = src;
      s.async = true;
      s.onload = function () { clearTimeout(timer); resolve(src); };
      s.onerror = function () { clearTimeout(timer); s.remove(); reject(new Error("load failed")); };
      document.head.appendChild(s);
    });
  }

  function loadFirst(urls) {
    var i = 0;
    function next() {
      if (i >= urls.length) return Promise.reject(new Error("모든 주소에서 불러오지 못했어요"));
      var u = urls[i++];
      return loadScript(u).catch(next);
    }
    return next();
  }

  // ---------- Firebase 연결 ----------
  function toMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts === "number") return ts;
    return 0;
  }

  function normalize(x) {
    var o = Object.assign({}, x);
    ["updatedAt", "overrideAt", "at", "editedAt"].forEach(function (k) { if (k in o) o[k] = toMs(o[k]); });
    return o;
  }

  function mapSnap(snap) {
    var out = {};
    snap.forEach(function (d) { out[d.id] = normalize(d.data({ serverTimestamps: "estimate" })); });
    return out;
  }

  function firebaseStore(opts) {
    var base = "https://www.gstatic.com/firebasejs/10.12.2/";
    var chain = loadScript(base + "firebase-app-compat.js")
      .then(function () { return opts.auth ? loadScript(base + "firebase-auth-compat.js") : null; })
      .then(function () { return loadScript(base + "firebase-firestore-compat.js"); });

    return chain.then(function () {
      var app = firebase.apps.length ? firebase.app() : firebase.initializeApp(fb);
      var db = firebase.firestore(app);
      var auth = opts.auth ? firebase.auth(app) : null;
      var ts = function () { return firebase.firestore.FieldValue.serverTimestamp(); };

      return {
        demo: false,
        onStatus: function (cb, err) {
          return db.collection("status").onSnapshot(function (s) { cb(mapSnap(s)); }, err);
        },
        onRoom: function (id, cb, err) {
          return db.collection("status").doc(id).onSnapshot(function (d) {
            cb(d.exists ? normalize(d.data({ serverTimestamps: "estimate" })) : null);
          }, err);
        },
        onDevices: function (cb, err) {
          return db.collection("devices").onSnapshot(function (s) { cb(mapSnap(s)); }, err);
        },
        onRooms: function (cb, err) {
          return db.collection("rooms").onSnapshot(function (s) { cb(mapSnap(s)); }, err);
        },
        onRoomInfo: function (id, cb, err) {
          return db.collection("rooms").doc(id).onSnapshot(function (d) {
            cb(d.exists ? normalize(d.data({ serverTimestamps: "estimate" })) : null);
          }, err);
        },
        saveRoom: function (id, data) {
          return db.collection("rooms").doc(id).set(Object.assign({}, data, { editedAt: ts() }), { merge: true });
        },
        // 교실을 완전히 지움 (교실 정보 + 혼잡도 + 태블릿 상태). 되돌릴 수 없어요.
        deleteRoom: function (id) {
          var b = db.batch();
          ["rooms", "status", "devices"].forEach(function (c) { b.delete(db.collection(c).doc(id)); });
          return b.commit();
        },
        writeStatus: function (id, level, count) {
          return db.collection("status").doc(id).set({ level: level, count: count, updatedAt: ts() }, { merge: true });
        },
        writeDevice: function (id, data) {
          return db.collection("devices").doc(id).set(Object.assign({}, data, { at: ts() }), { merge: true });
        },
        setOverride: function (id, level) {
          return db.collection("status").doc(id).set({ override: isLevel(level) ? level : null, overrideAt: ts() }, { merge: true });
        },
        onAuth: function (cb) {
          return auth.onAuthStateChanged(function (u) { cb(u ? { email: u.email } : null); });
        },
        signIn: function (email, pw) { return auth.signInWithEmailAndPassword(email, pw); },
        signOut: function () { return auth.signOut(); },
        // 로그인한 계정의 비밀번호가 맞는지 다시 확인 (태블릿 버튼 잠금 해제용)
        verifyPassword: function (pw) {
          var u = auth.currentUser;
          if (!u) return Promise.reject({ code: "auth/no-user" });
          var cred = firebase.auth.EmailAuthProvider.credential(u.email, pw);
          return u.reauthenticateWithCredential(cred);
        }
      };
    });
  }

  // ---------- 예시 모드 (Firebase 설정 전) ----------
  function demoStore() {
    var now = Date.now();
    var status = {}, devices = {};
    var seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

    rooms.forEach(function (r) {
      var count = Math.floor(rnd() * (r.busyAt + 6));
      var lv = levelFromCount(r, count);
      status[r.id] = { level: lv, count: count, updatedAt: now - Math.floor(rnd() * 150000), override: null };
      devices[r.id] = {
        count: count, level: lv, battery: Math.round((0.45 + rnd() * 0.55) * 100) / 100,
        charging: rnd() > 0.15, at: now - Math.floor(rnd() * 50000), ms: Math.round(380 + rnd() * 240)
      };
    });
    // 현실감을 위해: 하나는 태블릿 꺼짐, 하나는 배터리 부족, 하나는 담당자가 직접 설정
    var off = rooms[5], low = rooms[8], man = rooms[12];
    var offId = off ? off.id : null;
    if (off) { status[off.id].updatedAt = now - 31 * 60000; devices[off.id].at = now - 29 * 60000; }
    if (low) { devices[low.id].battery = 0.14; devices[low.id].charging = false; }
    if (man) { status[man.id].override = 2; status[man.id].overrideAt = now - 6 * 60000; }

    var info = {};
    var subs = [], roomSubs = [], devSubs = [], infoSubs = [], infoRoomSubs = [];
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function emit() {
      subs.forEach(function (f) { f(clone(status)); });
      devSubs.forEach(function (f) { f(clone(devices)); });
      roomSubs.forEach(function (s) { s.cb(status[s.id] ? clone(status[s.id]) : null); });
    }
    function emitInfo() {
      infoSubs.forEach(function (f) { f(clone(info)); });
      infoRoomSubs.forEach(function (s) { s.cb(info[s.id] ? clone(info[s.id]) : null); });
    }
    function sub(list, item, first) {
      list.push(item);
      setTimeout(first, 0);
      return function () { var i = list.indexOf(item); if (i >= 0) list.splice(i, 1); };
    }

    setInterval(function () {
      var r = rooms[Math.floor(Math.random() * rooms.length)];
      if (!r || r.id === offId) return;
      var st = status[r.id];
      if (!st || !devices[r.id]) return;
      var c = Math.max(0, (st.count || 0) + Math.round((Math.random() - 0.45) * 6));
      st.count = c;
      st.level = levelFromCount(r, c);
      st.updatedAt = Date.now();
      Object.assign(devices[r.id], { count: c, level: st.level, at: Date.now() });
      emit();
    }, 5000);

    return {
      demo: true,
      onStatus: function (cb) { return sub(subs, cb, function () { cb(clone(status)); }); },
      onRoom: function (id, cb) { return sub(roomSubs, { id: id, cb: cb }, function () { cb(status[id] ? clone(status[id]) : null); }); },
      onDevices: function (cb) { return sub(devSubs, cb, function () { cb(clone(devices)); }); },
      onRooms: function (cb) { return sub(infoSubs, cb, function () { cb(clone(info)); }); },
      onRoomInfo: function (id, cb) { return sub(infoRoomSubs, { id: id, cb: cb }, function () { cb(info[id] ? clone(info[id]) : null); }); },
      saveRoom: function (id, data) { info[id] = Object.assign(info[id] || {}, data, { editedAt: Date.now() }); emitInfo(); return Promise.resolve(); },
      deleteRoom: function (id) { delete info[id]; delete status[id]; delete devices[id]; emit(); emitInfo(); return Promise.resolve(); },
      writeStatus: function (id, level, count) { status[id] = Object.assign(status[id] || {}, { level: level, count: count, updatedAt: Date.now() }); emit(); return Promise.resolve(); },
      writeDevice: function (id, data) { devices[id] = Object.assign(devices[id] || {}, data, { at: Date.now() }); emit(); return Promise.resolve(); },
      setOverride: function (id, level) { status[id] = Object.assign(status[id] || {}, { override: isLevel(level) ? level : null, overrideAt: Date.now() }); emit(); return Promise.resolve(); },
      onAuth: function (cb) { setTimeout(function () { cb({ email: "예시 모드" }); }, 0); return function () {}; },
      signIn: function () { return Promise.resolve(); },
      signOut: function () { return Promise.resolve(); },
      verifyPassword: function () { return Promise.resolve(); }
    };
  }

  // ---------- 옛날 브라우저용: 1분마다 새로 받아오기 (읽기 전용) ----------
  function fsValue(v) {
    if (!v) return null;
    if ("integerValue" in v) return parseInt(v.integerValue, 10);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("stringValue" in v) return v.stringValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("timestampValue" in v) return Date.parse(String(v.timestampValue).replace(/(\.\d{3})\d+/, "$1"));
    return null;
  }

  function parseRest(json) {
    var out = {};
    (json.documents || []).forEach(function (d) {
      var id = String(d.name).split("/").pop();
      var o = {};
      Object.keys(d.fields || {}).forEach(function (k) { o[k] = fsValue(d.fields[k]); });
      out[id] = o;
    });
    return out;
  }

  function restList(col) {
    var url = "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(fb.projectId) +
      "/databases/(default)/documents/" + col + "?pageSize=300&key=" + encodeURIComponent(fb.apiKey);
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(parseRest);
  }

  function restStore() {
    function poll(col, ms, cb, err) {
      var stopped = false, t = null;
      function go() {
        restList(col).then(function (m) { if (!stopped) cb(m); }, function (e) { if (!stopped && err) err(e); })
          .then(function () { if (!stopped) t = setTimeout(go, ms); });
      }
      go();
      return function () { stopped = true; clearTimeout(t); };
    }
    return {
      demo: false,
      rest: true,
      onStatus: function (cb, err) { return poll("status", 60000, cb, err); },
      onRooms: function (cb, err) { return poll("rooms", 120000, cb, err); }
    };
  }

  var storeP = null;
  function store(opts) {
    if (!storeP) storeP = demo ? Promise.resolve(demoStore()) : firebaseStore(opts || {});
    return storeP;
  }

  function authErrorText(e) {
    var code = (e && e.code) || "";
    var map = {
      "auth/invalid-credential": "이메일이나 비밀번호가 맞지 않아요.",
      "auth/wrong-password": "비밀번호가 맞지 않아요.",
      "auth/user-not-found": "등록되지 않은 이메일이에요. Firebase 콘솔에서 사용자를 추가해 주세요.",
      "auth/invalid-email": "이메일 형식이 맞지 않아요.",
      "auth/too-many-requests": "여러 번 틀려서 잠시 막혔어요. 몇 분 뒤에 다시 해 주세요.",
      "auth/network-request-failed": "인터넷에 연결되지 않았어요. 와이파이를 확인해 주세요.",
      "auth/operation-not-allowed": "Firebase 콘솔에서 이메일/비밀번호 로그인을 켜 주세요.",
      "auth/missing-password": "비밀번호를 입력해 주세요.",
      "auth/no-user": "로그인이 풀렸어요. 새로고침해서 다시 로그인해 주세요."
    };
    return map[code] || ("로그인하지 못했어요. (" + (code || (e && e.message) || "알 수 없는 오류") + ")");
  }

  window.App = {
    config: C,
    counter: COUNTER,
    rooms: rooms,
    room: room,
    EDITABLE: EDITABLE,
    mergeRoom: mergeRoom,
    mergeAll: mergeAll,
    removedRooms: removedRooms,
    isRemoved: isRemoved,
    makeId: makeId,
    floors: floors,
    grades: grades,
    LEVELS: LEVELS,
    levelFromCount: levelFromCount,
    effective: effective,
    levelKey: levelKey,
    levelLabel: levelLabel,
    isLevel: isLevel,
    ago: ago,
    clock: clock,
    el: el,
    demo: demo,
    store: store,
    restStore: restStore,
    parseRest: parseRest,
    loadScript: loadScript,
    loadFirst: loadFirst,
    authErrorText: authErrorText,
    STALE_MS: STALE_MS,
    OFFLINE_MS: OFFLINE_MS
  };
})();
