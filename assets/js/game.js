(() => {
	const $ = s => document.querySelector(s);
	const $$ = s => [...document.querySelectorAll(s)];

	/* ---------- 月の一覧（assets/js/months.js） ---------- */
	// id は「年-月」なので、2026-10 と 2027-10 は別の月として扱える
	const MONTHS = (window.CHOSU_MONTHS || []).map(m => {
		const [year, month] = m.id.split('-').map(Number);
		const days = Array.isArray(m.days) ? m.days : Array.from({ length: m.days }, (_, i) => i + 1);
		return { id: m.id, year, month, days };
	}).sort((a, b) => b.id.localeCompare(a.id));

	// layouts は [列, 行] の候補。画面の縦横に合わせて、カードが大きくなる方を使う
	const LEVELS = {
		easy: { pairs: 6, layouts: [[4, 3], [3, 4]] },
		normal: { pairs: 10, layouts: [[5, 4], [4, 5]] },
		hard: { pairs: 15, layouts: [[6, 5], [5, 6]] },
	};
	const PLAYERS = [
		{ name: 'ちょす' },
		{ name: 'にくまん' },
	];
	const FLIP_BACK_MS = 900;
	const GONE_MS = 950;

	const settings = { month: MONTHS[0] && MONTHS[0].id, level: 'easy', players: 1 };
	let game = null;

	/* ---------- 効果音（Web Audio で合成） ---------- */
	let actx = null, muted = false;
	function tone(freq, start, dur, type = 'sine', vol = 0.18) {
		if (muted) return;
		if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
		if (actx.state === 'suspended') actx.resume();
		const t = actx.currentTime + start;
		const o = actx.createOscillator(), g = actx.createGain();
		o.type = type; o.frequency.setValueAtTime(freq, t);
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(vol, t + 0.008);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		o.connect(g); g.connect(actx.destination);
		o.start(t); o.stop(t + dur + 0.02);
	}
	const sfx = {
		flip: () => tone(880, 0, 0.08, 'triangle', 0.12),
		match: () => { tone(784, 0, 0.25); tone(1047, 0.09, 0.35); },
		miss: () => { tone(330, 0, 0.14, 'triangle', 0.1); tone(262, 0.1, 0.18, 'triangle', 0.1); },
		clear: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.11, i === 5 ? 0.6 : 0.18, 'sine', 0.16)),
	};

	/* ---------- ユーティリティ ---------- */
	const monthOf = id => MONTHS.find(m => m.id === id) || MONTHS[0];
	const imgSrc = (m, day) => `assets/cards/${m.id}/${String(day).padStart(2, '0')}.webp`;
	const dateLabel = (m, day) => `${m.month}/${day}`;

	function shuffle(a) {
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	}

	const fmt = ms => {
		const s = Math.floor(ms / 1000);
		return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
	};

	const store = {
		get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
		set(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* 保存できなくても遊べる */ } },
	};
	const bestKey = (monthId, level) => `chosumatch_best_${monthId}_${level}`;
	function loadBest(monthId, level) {
		try { return JSON.parse(store.get(bestKey(monthId, level))); } catch (e) { return null; }
	}

	/* ---------- 画面切り替え ---------- */
	function show(screen) {
		$('#titleScreen').hidden = screen !== 'title';
		$('#gameScreen').hidden = screen !== 'game';
		window.scrollTo(0, 0);
	}

	/* ---------- ゲーム ---------- */
	async function start() {
		const m = monthOf(settings.month);
		const lv = LEVELS[settings.level];
		const days = shuffle(m.days.slice()).slice(0, lv.pairs);
		// 先に画像を読み込んでおき、めくった瞬間に絵が出るようにする
		const btns = [$('#startBtn'), $('#againBtn')];
		btns.forEach(b => { b.disabled = true; });
		await Promise.all(days.map(d => new Promise(res => {
			const im = new Image(); im.onload = im.onerror = res; im.src = imgSrc(m, d);
		})));
		btns.forEach(b => { b.disabled = false; });

		stopTimer();
		game = {
			m, lv, level: settings.level, players: settings.players,
			deck: shuffle(days.concat(days)).map(day => ({ day, state: 'closed' })),
			first: null, lock: false, moves: 0, found: 0,
			startAt: 0, elapsed: 0, timer: null,
			turn: 0, scores: [0, 0], foundDays: [],
		};
		closeModal();
		show('game');
		renderBoard();
		$('#tray').innerHTML = '';
		renderHud();
	}

	function stopTimer() {
		if (game && game.timer) { clearInterval(game.timer); game.timer = null; }
	}

	function renderBoard() {
		const b = $('#board');
		b.innerHTML = '';
		game.deck.forEach((c, i) => {
			const el = document.createElement('button');
			el.type = 'button';
			el.className = 'card';
			el.setAttribute('aria-label', 'カード');
			el.innerHTML = `<span class="card__inner">
				<span class="card__face card__back"><img src="assets/img/nikuman.webp" alt="" draggable="false"></span>
				<span class="card__face card__front"><img alt="" draggable="false"></span>
			</span>`;
			el.querySelector('.card__front img').src = imgSrc(game.m, c.day);
			el.addEventListener('click', () => flip(i));
			c.el = el;
			b.appendChild(el);
		});
		layoutBoard();
	}

	// 盤面を画面に収まる最大サイズにする（カードは 3:4）
	function layoutBoard() {
		if (!game) return;
		const wrap = $('#boardWrap'), b = $('#board');
		const cs = getComputedStyle(b);
		const gap = parseFloat(cs.getPropertyValue('--gap')) || 8;
		const chromeX = parseFloat(cs.paddingLeft) * 2 + parseFloat(cs.borderLeftWidth) * 2;
		const chromeY = parseFloat(cs.paddingTop) * 2 + parseFloat(cs.borderTopWidth) * 2 + 6; // 6 = 下の影
		const W = wrap.clientWidth - chromeX, H = wrap.clientHeight - chromeY;
		let best = null;
		game.lv.layouts.forEach(([cols, rows]) => {
			const w = Math.min((W - gap * (cols - 1)) / cols, (H - gap * (rows - 1)) / rows * 0.75);
			if (!best || w > best.w) best = { cols, w };
		});
		b.style.setProperty('--cols', best.cols);
		b.style.setProperty('--card-w', Math.max(28, Math.floor(best.w)) + 'px');
	}

	function flip(i) {
		const c = game.deck[i];
		if (game.lock || c.state !== 'closed') return;
		if (!game.timer && !game.startAt && game.players === 1) {
			game.startAt = performance.now();
			game.timer = setInterval(renderHud, 250);
		}
		c.state = 'open';
		c.el.classList.add('is-open');
		c.el.setAttribute('aria-label', `${game.m.month}月${c.day}日のちょす`);
		sfx.flip();
		if (game.first === null) { game.first = i; return; }

		const a = game.deck[game.first];
		game.first = null;
		game.moves++;
		if (a.day === c.day) {
			const who = game.turn;
			a.state = c.state = 'done';
			setTimeout(() => {
				[a, c].forEach(x => x.el.classList.replace('is-open', 'is-done'));
				sfx.match();
			}, 260);
			// 少し見せてから盤面から抜き、下の置き場に移す
			setTimeout(() => {
				[a, c].forEach(x => {
					x.el.classList.add('is-gone');
					x.el.disabled = true;
					x.el.setAttribute('aria-label', 'そろえたカード');
				});
				addToTray(c.day, who);
			}, GONE_MS);
			game.found++;
			game.scores[who]++;
			game.foundDays.push({ day: c.day, who });
			renderHud();
			if (game.found === game.lv.pairs) {
				// 最後の1組はタイムをすぐ止める
				game.elapsed = performance.now() - game.startAt;
				stopTimer();
				setTimeout(finish, GONE_MS + 450);
			}
		} else {
			game.lock = true;
			a.el.classList.add('is-miss'); c.el.classList.add('is-miss');
			setTimeout(sfx.miss, 450);
			setTimeout(() => {
				[a, c].forEach(x => {
					x.state = 'closed';
					x.el.classList.remove('is-open', 'is-miss');
					x.el.setAttribute('aria-label', 'カード');
				});
				// ふたりモードは外したら交代（そろえたら続けてめくれる）
				if (game.players === 2) game.turn = 1 - game.turn;
				game.lock = false;
				renderHud();
			}, FLIP_BACK_MS);
			renderHud();
		}
	}

	function addToTray(day, who) {
		const el = document.createElement('div');
		el.className = 'tray__card' + (game.players === 2 ? ` tray__card--${who + 1}` : '');
		el.innerHTML = '<img alt="">';
		el.querySelector('img').src = imgSrc(game.m, day);
		el.querySelector('img').alt = `${game.m.month}月${day}日`;
		$('#tray').appendChild(el);
	}

	const elapsed = () => (game.timer ? performance.now() - game.startAt : game.elapsed);

	function renderHud() {
		if (!game) return;
		const counter = $('#counter'), status = $('#status');
		if (game.players === 1) {
			counter.innerHTML = `<span class="counter__label">MOVES</span><span class="counter__num">${game.moves}</span>`;
			status.innerHTML = `
				<span class="pill">タイム <b>${fmt(elapsed())}</b></span>
				<span class="pill">そろえた <b>${game.found} / ${game.lv.pairs}</b></span>`;
		} else {
			const p = PLAYERS[game.turn];
			// 番が変わったときだけ作り直して、登場アニメーションを出す
			if (counter.dataset.turn !== String(game.turn)) {
				counter.dataset.turn = game.turn;
				counter.innerHTML = `<span class="counter__turn"><span class="avatar avatar--${game.turn + 1}"></span>${p.name}のばん</span>`;
			}
			status.innerHTML = PLAYERS.map((pl, i) => `
				<span class="player player--${i + 1} ${game.turn === i ? 'is-turn' : ''}">
					<span class="avatar avatar--${i + 1}"></span>
					<span class="player__name">${pl.name}</span>
					<span class="player__score">${game.scores[i]}<small>くみ</small></span>
				</span>`).join('');
		}
		if (game.players === 1) delete counter.dataset.turn;
	}

	function finish() {
		stopTimer();
		sfx.clear();
		let msg;
		if (game.players === 1) {
			const best = loadBest(game.m.id, game.level);
			const isBest = !best || game.moves < best.moves || (game.moves === best.moves && game.elapsed < best.time);
			if (isBest) store.set(bestKey(game.m.id, game.level), JSON.stringify({ moves: game.moves, time: game.elapsed }));
			const perfect = game.moves === game.lv.pairs;
			msg = `<p class="modal__big"><b>${game.moves}</b>手 ・ <b>${fmt(game.elapsed)}</b></p>`
				+ (perfect ? '<p class="modal__note">ぜんぶ1回でそろえた！すごい！</p>' : '')
				+ (isBest ? '<span class="badge">ベスト記録こうしん</span>' : '');
		} else {
			const [s1, s2] = game.scores;
			const who = s1 === s2 ? 'ひきわけ！' : `${PLAYERS[s1 > s2 ? 0 : 1].name}のかち！`;
			msg = `<p class="modal__big">${who}</p><p class="modal__note">${PLAYERS[0].name} ${s1}くみ ・ ${PLAYERS[1].name} ${s2}くみ</p>`;
		}
		$('#clearMsg').innerHTML = msg;
		$('#albumLabel').textContent = `そろえた ${game.m.year}年${game.m.month}月のちょす`;
		const album = $('#album');
		album.innerHTML = '';
		game.foundDays.slice().sort((a, b) => a.day - b.day).forEach(({ day }) => {
			const fig = document.createElement('figure');
			fig.innerHTML = '<img alt=""><figcaption></figcaption>';
			fig.querySelector('img').src = imgSrc(game.m, day);
			fig.querySelector('img').alt = `${game.m.month}月${day}日`;
			fig.querySelector('figcaption').textContent = dateLabel(game.m, day);
			album.appendChild(fig);
		});
		$('#modal').hidden = false;
		$('#againBtn').focus();
	}

	function closeModal() {
		$('#modal').hidden = true;
	}

	function toTitle() {
		stopTimer();
		closeModal();
		game = null;
		renderBest();
		show('title');
	}

	// 遊んでいる途中なら確認を出す（まだ1枚もめくっていなければそのまま戻る）
	function askQuit() {
		const playing = game && (game.moves > 0 || game.first !== null) && game.found < game.lv.pairs;
		if (!playing) { toTitle(); return; }
		// 確認中はタイムを止める
		if (game.timer) {
			game.elapsed = performance.now() - game.startAt;
			stopTimer();
			game.paused = true;
		}
		$('#quitModal').hidden = false;
		$('#quitCancelBtn').focus();
	}

	function cancelQuit() {
		$('#quitModal').hidden = true;
		if (game && game.paused) {
			game.paused = false;
			game.startAt = performance.now() - game.elapsed;
			game.timer = setInterval(renderHud, 250);
		}
		$('#backBtn').focus();
	}

	/* ---------- タイトル画面 ---------- */
	function buildMonthSelect() {
		const sel = $('#month');
		const years = [...new Set(MONTHS.map(m => m.year))];
		years.forEach(y => {
			const g = document.createElement('optgroup');
			g.label = `${y}年`;
			MONTHS.filter(m => m.year === y).forEach(m => {
				g.appendChild(new Option(`${m.year}年 ${m.month}月（${m.days.length}まい）`, m.id));
			});
			sel.appendChild(g);
		});
		const saved = store.get('chosumatch_month');
		if (saved && MONTHS.some(m => m.id === saved)) settings.month = saved;
		sel.value = settings.month;
		sel.addEventListener('change', () => {
			settings.month = sel.value;
			store.set('chosumatch_month', sel.value);
			renderBest();
		});
	}

	function renderBest() {
		const el = $('#bestLine');
		if (settings.players !== 1) { el.textContent = 'ふたりで交互にめくって、たくさんそろえた方のかち'; return; }
		const best = loadBest(settings.month, settings.level);
		el.textContent = best ? `ベスト記録　${best.moves}手 ・ ${fmt(best.time)}` : 'ベスト記録　まだありません';
	}

	$$('.seg').forEach(seg => {
		const key = seg.dataset.group;
		seg.addEventListener('click', e => {
			const btn = e.target.closest('button');
			if (!btn) return;
			seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b === btn)));
			settings[key] = key === 'players' ? +btn.dataset.value : btn.dataset.value;
			renderBest();
		});
	});

	/* ---------- 共通の操作 ---------- */
	const applySound = () => $$('.sound-btn').forEach(b => {
		b.setAttribute('aria-pressed', String(!muted));
		b.setAttribute('aria-label', muted ? '効果音：オフ' : '効果音：オン');
	});
	$$('.sound-btn').forEach(b => b.addEventListener('click', () => {
		muted = !muted;
		applySound();
		store.set('chosumatch_sound', muted ? 'off' : 'on');
	}));
	muted = store.get('chosumatch_sound') === 'off';
	applySound();

	$('#startBtn').addEventListener('click', start);
	$('#againBtn').addEventListener('click', start);
	$('#toTitleBtn').addEventListener('click', toTitle);
	$('#backBtn').addEventListener('click', askQuit);
	$('#quitCancelBtn').addEventListener('click', cancelQuit);
	$('#quitOkBtn').addEventListener('click', () => { $('#quitModal').hidden = true; toTitle(); });
	$('#quitModal').addEventListener('click', e => { if (e.target.id === 'quitModal') cancelQuit(); });
	$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') toTitle(); });
	document.addEventListener('keydown', e => {
		if (e.key !== 'Escape') return;
		if (!$('#quitModal').hidden) cancelQuit();
		else if (!$('#modal').hidden) toTitle();
	});
	new ResizeObserver(layoutBoard).observe($('#boardWrap'));

	buildMonthSelect();
	renderBest();
})();
