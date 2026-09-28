/* =======================================================================
   アプリ本体
   -----------------------------------------------------------------------
   問題データは questions.js 側にあります。このファイルは表示・採点・保存の
   ロジックだけを持ちます。index.html より後に読み込まれる前提です。
   ======================================================================= */

/* ===================== 状態 ===================== */
let list = [];   // 出題中の問題（順番込み）
let idx = 0;
let state = {};  // qid -> {vals:{}, choice, graded, correct}
let savedScope = '';   // 出題範囲の「確定済みの値」。変更を取り消したときに戻す先

/* 出題をまたいで残る成績。qid -> {asked, wrong, streak, review}
   streak は「連続正解の回数」、review は「復習リストに入っているか」 */
let stats = {};
/* この回で成績に数えた問題。やり直しや再読み込みで二重に数えないため */
let counted = new Set();

const REVIEW_STREAK  = 3;   // これだけ連続で正解したら復習リストから自動で外す
const STUBBORN_WRONG = 5;   // 通算でこれだけ間違えた問題は自動では外さない（手動のみ）

const el = {
  main: document.getElementById('main'),
  score: document.getElementById('score'),
  bar: document.getElementById('barfill'),
  barbox: document.getElementById('bar'),
  scope: document.getElementById('scope'),
  shuffle: document.getElementById('shuffle'),
  hint: document.getElementById('hint'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  check: document.getElementById('check'),
  restart: document.getElementById('restart'),
  resetStats: document.getElementById('reset-stats'),
};

/* ===================== 保存・復元 ===================== */
/* 出題範囲などの設定と、解答の途中経過を localStorage に保存する。
   file:// で開くと保存が使えないブラウザもあるため、必ず try/catch で包む。 */
const STORE_KEY = 'kojin-quiz.v1';
/* 通算成績は途中経過とは別のキーに置く。「最初から」や出題範囲の変更で
   途中経過を捨てても、間違えた記録は消えないようにするため */
const STATS_KEY = 'kojin-quiz.stats.v1';

function save(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify({
      scope: el.scope.value,
      shuffle: el.shuffle.checked,
      hint: el.hint.checked,
      ids: list.map(q => q.id),
      idx: idx,
      state: state,
      counted: [...counted],
    }));
  }catch(e){ /* 保存できない環境では黙って諦める */ }
}

function loadSaved(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}

function clearSaved(){
  try{ localStorage.removeItem(STORE_KEY); }catch(e){}
}

/* ===================== 通算成績（復習リストの土台） ===================== */
/* 壊れた値や手で書き換えられた値を持ち込まないよう、読み込み時に形を整える */
function loadStats(){
  let raw = null;
  try{ raw = JSON.parse(localStorage.getItem(STATS_KEY) || 'null'); }catch(e){ raw = null; }
  const out = {};
  if (raw && typeof raw === 'object'){
    const known = new Set(QUESTIONS.map(q => q.id));
    Object.keys(raw).forEach(id => {
      if (!known.has(id)) return;                  // 消えた問題の記録は引き継がない
      const s = raw[id] || {};
      const n = v => (Number.isFinite(v) && v >= 0) ? Math.floor(v) : 0;
      out[id] = { asked: n(s.asked), wrong: n(s.wrong), streak: n(s.streak), review: !!s.review };
    });
  }
  stats = out;
}

function saveStats(){
  try{ localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }catch(e){}
}

function statOf(id){
  return stats[id] || (stats[id] = { asked: 0, wrong: 0, streak: 0, review: false });
}

/* 採点が確定したときに 1 問 1 回だけ呼ぶ */
function record(q, correct){
  const s = statOf(q.id);
  s.asked++;
  if (correct){
    s.streak++;
    // 3回連続で正解できたら卒業。ただし通算5回以上間違えた問題は手動で消すまで残す
    if (s.review && s.streak >= REVIEW_STREAK && s.wrong < STUBBORN_WRONG) s.review = false;
  } else {
    s.wrong++;
    s.streak = 0;
    s.review = true;
  }
  saveStats();
  refreshScope();
}

/* 復習リスト。出題順を安定させるため QUESTIONS の並び順で返す */
function reviewQuestions(){
  return QUESTIONS.filter(q => stats[q.id] && stats[q.id].review);
}

function isStubborn(id){
  const s = stats[id];
  return !!s && s.wrong >= STUBBORN_WRONG;
}

/* 手動で復習リストから外す。間違えればまた戻ってくる */
function dropFromReview(id){
  const s = stats[id];
  if (!s) return;
  s.review = false;
  saveStats();
  refreshScope();
}

/* 項目（cat）ごとに合算する。cat -> {asked, wrong} */
function catStats(){
  const m = new Map();
  QUESTIONS.forEach(q => {
    const s = stats[q.id];
    if (!s || !s.asked) return;
    const c = m.get(q.cat) || { asked: 0, wrong: 0 };
    c.asked += s.asked;
    c.wrong += s.wrong;
    m.set(q.cat, c);
  });
  return m;
}

function resetStats(){
  if (!Object.keys(stats).length){
    alert('記録はまだありません。');
    return;
  }
  if (!confirm('項目ごとの成績と復習リストをすべて消します。よろしいですか？\n（いま解いている途中経過は消えません）')) return;
  stats = {};
  counted = new Set();
  try{ localStorage.removeItem(STATS_KEY); }catch(e){}
  refreshScope();
  render();
}

/* 保存済みの設定をフォームに戻す（出題範囲の選択肢が消えている場合は既定値のまま） */
function restoreSettings(s){
  if (!s) return;
  if (typeof s.scope === 'string' && [...el.scope.options].some(o => o.value === s.scope)){
    el.scope.value = s.scope;
  }
  if (typeof s.shuffle === 'boolean') el.shuffle.checked = s.shuffle;
  if (typeof s.hint === 'boolean') el.hint.checked = s.hint;
}

/* 保存済みの途中経過を復元できたら true。問題データが変わっていたら false を返す */
function restoreProgress(s){
  if (!s || !Array.isArray(s.ids) || !s.ids.length) return false;
  const byId = new Map(QUESTIONS.map(q => [q.id, q]));
  const restored = s.ids.map(id => byId.get(id));
  if (restored.some(q => !q)) return false;      // 問題が削除・改番されている
  list = restored;
  state = (s.state && typeof s.state === 'object') ? s.state : {};
  counted = new Set(Array.isArray(s.counted) ? s.counted : []);
  idx = Number.isInteger(s.idx) ? Math.min(Math.max(s.idx, 0), list.length) : 0;
  savedScope = el.scope.value;
  render();
  return true;
}

/* ===================== 判定用ユーティリティ ===================== */
function norm(s){
  return (s || '')
    .normalize('NFKC')
    .replace(/[\s\u3000]/g, '')
    .replace(/[、。，．・「」『』（）()【】]/g, '')
    .toLowerCase();
}
function accepts(ansDef){
  return Array.isArray(ansDef) ? ansDef : [ansDef];
}
function canonical(ansDef){
  const a = accepts(ansDef)[0];
  return typeof a === 'string' ? a : '';   // answers のキー漏れでも描画を止めない
}
function isCorrectBlank(ansDef, input){
  const v = norm(input);
  return v !== '' && accepts(ansDef).some(a => norm(a) === v);
}
/* 空欄番号を出現順に取り出す（重複は1つに） */
function labelsOf(q){
  const seen = [];
  (q.text.match(/\[\[(\d+)\]\]/g) || []).forEach(m => {
    const n = m.replace(/\D/g, '');
    if (!seen.includes(n)) seen.push(n);
  });
  return seen;
}

/* ===================== データ検証 ===================== */
/* 問題を追記したときの書き間違いを起動時に見つける。
   とくに [[1]] を [1] と書くと空欄が 0 個になり、黙って「全問正解」になってしまう。 */
function validateQuestions(){
  const issues = [];
  const seenIds = new Set();
  QUESTIONS.forEach((q, i) => {
    const where = q && q.id ? q.id : '#' + (i + 1);
    if (!q || !q.id || !q.type || !q.title || typeof q.text !== 'string'){
      issues.push(where + '：id / type / title / text のいずれかが欠けています');
      return;
    }
    if (seenIds.has(q.id)) issues.push(q.id + '：id が重複しています');
    seenIds.add(q.id);

    if (q.type === 'fill'){
      const labels = labelsOf(q);
      if (!labels.length){
        issues.push(q.id + '：空欄がありません（[[1]] の書き方を確認してください）');
      }
      const keys = Object.keys(q.answers || {});
      labels.filter(n => !keys.includes(n))
        .forEach(n => issues.push(q.id + '：[[' + n + ']] に対応する answers がありません'));
      keys.filter(k => !labels.includes(k))
        .forEach(k => issues.push(q.id + '：answers の ' + k + ' に対応する空欄が本文にありません'));
      keys.forEach(k => {
        if (accepts(q.answers[k]).some(a => typeof a !== 'string' || !a.trim())){
          issues.push(q.id + '：answers の ' + k + ' が空、または文字列ではありません');
        }
      });
    } else if (q.type === 'ox'){
      if (q.answer !== '○' && q.answer !== '×'){
        issues.push(q.id + '：answer は \'○\' か \'×\' にしてください');
      }
      if (/\[\[\d+\]\]/.test(q.text)) issues.push(q.id + '：○×問題の本文に空欄記法が残っています');
    } else {
      issues.push(q.id + '：type は \'fill\' か \'ox\' のどちらかです（' + q.type + '）');
    }
  });
  return issues;
}

/* 不備が見つかったら本人に見えるところへ出す（コンソールだけだと気づけない） */
function reportIssues(issues){
  if (!issues.length) return;
  console.warn('[questions.js] データの不備が ' + issues.length + ' 件あります');
  issues.forEach(m => console.warn('  - ' + m));
  const box = document.createElement('div');
  box.className = 'issues';
  box.innerHTML = '<b>questions.js に不備が ' + issues.length + ' 件あります</b><ul>' +
    issues.map(m => '<li>' + esc(m) + '</li>').join('') + '</ul>';
  el.main.parentNode.insertBefore(box, el.main);
}

/* ===================== 出題リストの構築 ===================== */
function reviewLabel(){
  return '復習リスト（間違えた問題）（' + reviewQuestions().length + '問）';
}

function buildScope(){
  const cats = [...new Set(QUESTIONS.map(q => q.cat))];
  const opts = [
    ['all', 'すべて（' + QUESTIONS.length + '問）'],
    ['review', reviewLabel()],
    ['type:fill', '虫食い問題のみ（' + QUESTIONS.filter(q => q.type === 'fill').length + '問）'],
    ['type:ox', '○×問題のみ（' + QUESTIONS.filter(q => q.type === 'ox').length + '問）'],
    ...cats.map(c => ['cat:' + c, c + '（' + QUESTIONS.filter(q => q.cat === c).length + '問）'])
  ];
  el.scope.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
}

/* 復習リストの件数は解くたびに変わる。選択を保ったまま表示だけ差し替える */
function refreshScope(){
  const opt = [...el.scope.options].find(o => o.value === 'review');
  if (opt) opt.textContent = reviewLabel();
}

function selectQuestions(){
  const v = el.scope.value;
  if (v === 'review') return reviewQuestions();
  if (v.startsWith('type:')) return QUESTIONS.filter(q => q.type === v.slice(5));
  if (v.startsWith('cat:'))  return QUESTIONS.filter(q => q.cat === v.slice(4));
  return QUESTIONS.slice();
}

function start(questions){
  list = questions.slice();
  if (el.shuffle.checked){
    for (let i = list.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  state = {};
  counted = new Set();   // 新しい 1 周なので、成績への計上もやり直す
  idx = 0;
  savedScope = el.scope.value;
  render();
}

/* ===================== 描画 ===================== */
/* 空欄の幅。「字数に合わせる」が OFF のときは一律 8em */
function blankWidth(q, label){
  const len = canonical(q.answers && q.answers[label]).length;
  return (el.hint.checked ? Math.max(4.5, len + 1) : 8) + 'em';
}

/* 幅だけを更新する。再描画するとフォーカスが先頭の空欄に戻ってしまうため */
function applyBlankWidths(){
  const q = list[idx];
  if (!q || q.type !== 'fill') return;
  el.main.querySelectorAll('input.blank').forEach(inp => {
    inp.style.width = blankWidth(q, inp.dataset.label);
  });
}

/* 問題文の上に出す、この項目の通算成績。
   記録がない項目では何も出さない（初見のときに意味のない 0/0 を見せないため） */
function catStatChip(cat){
  const c = catStats().get(cat);
  if (!c || !c.asked) return '';
  const pct = Math.round(c.wrong / c.asked * 100);
  return `<span class="stat${pct >= 50 ? ' hot' : ''}">この項目 誤答 ${c.wrong} / ${c.asked}（${pct}%）</span>`;
}

function render(){
  save();
  if (idx >= list.length){ renderFinal(); return; }

  const q = list[idx];
  const st = state[q.id] || (state[q.id] = { vals: {}, choice: null, graded: false, correct: false });

  el.main.innerHTML = `
    <div class="meta">
      <span class="qno">${idx + 1} / ${list.length}</span>
      <span class="tag">${esc(q.cat)}</span>
      <span class="tag">${q.type === 'fill' ? '虫食い' : '○×'}</span>
      ${stats[q.id] && stats[q.id].review ? '<span class="tag review">復習中</span>' : ''}
      ${catStatChip(q.cat)}
    </div>
    <section class="card">
      <h2>${esc(q.title)}</h2>
      <div class="body" id="body"></div>
      <div id="extra"></div>
      <div id="result" aria-live="polite"></div>
    </section>`;

  const body = document.getElementById('body');

  if (q.type === 'fill'){
    // テキストを空欄で分割して差し込む
    const parts = q.text.split(/\[\[(\d+)\]\]/);
    parts.forEach((p, i) => {
      if (i % 2 === 0){
        body.appendChild(document.createTextNode(p));
      } else {
        const wrap = document.createElement('span');
        wrap.className = 'blankwrap';
        const lab = document.createElement('span');
        lab.className = 'lab';
        lab.textContent = '(' + p + ')';
        lab.setAttribute('aria-hidden', 'true');   // 番号は input の aria-label で読ませる
        const inp = document.createElement('input');
        inp.className = 'blank';
        inp.type = 'text';
        inp.dataset.label = p;
        inp.value = st.vals[p] || '';
        inp.autocomplete = 'off';
        inp.spellcheck = false;
        inp.setAttribute('aria-label', '空欄 (' + p + ')');
        inp.style.width = blankWidth(q, p);
        if (st.graded){
          inp.disabled = true;
          inp.classList.add(isCorrectBlank(q.answers[p], st.vals[p]) ? 'ok' : 'ng');
        }
        // 同じ番号の空欄は入力を同期
        inp.addEventListener('input', () => {
          st.vals[p] = inp.value;
          body.querySelectorAll('input.blank[data-label="' + p + '"]').forEach(o => {
            if (o !== inp) o.value = inp.value;
          });
          clearWarn();
          save();
        });
        wrap.appendChild(lab);
        wrap.appendChild(inp);
        body.appendChild(wrap);
      }
    });
    if (!st.graded){
      const first = body.querySelector('input.blank');
      if (first) first.focus();
    }
  } else {
    body.textContent = q.text;
    const row = document.createElement('div');
    row.className = 'oxrow';
    ['○', '×'].forEach(v => {
      const b = document.createElement('button');
      b.className = 'oxbtn';
      b.textContent = v;
      b.setAttribute('aria-label', v === '○' ? '正しい（○）' : '誤り（×）');
      b.setAttribute('aria-pressed', String(st.choice === v));
      if (st.graded){
        b.disabled = true;
        if (v === q.answer) b.classList.add('truth');
        else if (v === st.choice) b.classList.add('wrong');
      } else if (st.choice === v){
        b.classList.add('picked');
      }
      b.addEventListener('click', () => { st.choice = v; grade(); });
      row.appendChild(b);
    });
    document.getElementById('extra').appendChild(row);
  }

  if (st.graded) renderResult(q, st);
  updateChrome(q, st);
}

function renderResult(q, st){
  const box = document.getElementById('result');
  let html = '<div class="result">';
  html += `<div class="verdict ${st.correct ? 'ok' : 'ng'}">${st.correct ? '正解' : '不正解'}</div>`;
  html += reviewStatus(q);

  if (q.type === 'fill'){
    html += '<ul class="keys">';
    labelsOf(q).forEach(n => {
      const good = isCorrectBlank(q.answers[n], st.vals[n]);
      const mine = (st.vals[n] || '').trim();
      html += `<li><span class="n">(${n})</span><span class="a">${esc(canonical(q.answers[n]))}</span>`;
      html += good ? '' : `<span class="mine">あなたの解答：${mine ? esc(mine) : '（未入力）'}</span>`;
      html += '</li>';
    });
    html += '</ul>';
  } else {
    html += `<ul class="keys"><li><span class="n">正答</span><span class="a">${esc(q.answer)}</span>`;
    html += st.correct ? '' : `<span class="mine">あなたの解答：${esc(st.choice || '（未選択）')}</span>`;
    html += '</li></ul>';
  }

  if (q.note) html += `<div class="note">${fmtNote(q.note)}</div>`;
  html += '<button class="retry" id="retry">この問題をやり直す</button>';
  html += '</div>';
  box.innerHTML = html;
  document.getElementById('retry').addEventListener('click', retry);
  const drop = document.getElementById('drop');
  if (drop) drop.addEventListener('click', () => { dropFromReview(q.id); render(); });
}

/* この問題が復習リストのどこにいるかを採点結果の中に出す。
   「あと何回連続で正解すれば外れるか」が見えないと、終わりが分からず続かない */
function reviewStatus(q){
  const s = stats[q.id];
  if (!s || !s.asked) return '';
  let html = '<div class="streak">';
  html += `<span>この問題の通算　誤答 ${s.wrong} / ${s.asked}回</span>`;
  if (s.review && isStubborn(q.id)){
    html += `<span class="pin">通算${STUBBORN_WRONG}回以上まちがえたため、自動では外れません</span>`;
    html += '<button class="drop" id="drop">復習リストから外す</button>';
  } else if (s.review){
    html += `<span>復習リスト：連続正解 ${s.streak} / ${REVIEW_STREAK}` +
            `（あと${REVIEW_STREAK - s.streak}回で外れます）</span>`;
  } else if (s.wrong){
    html += '<span>復習リストには入っていません</span>';
  }
  html += '</div>';
  return html;
}

function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* 解説は「エスケープしてから」独自記法だけタグに戻す。
   **強調** → <b>強調</b>（データ側に生の HTML を書かせないため） */
function fmtNote(s){
  return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function setProgress(pct){
  const v = Math.round(pct);
  el.bar.style.width = v + '%';
  if (el.barbox){
    el.barbox.setAttribute('aria-valuenow', String(v));
    el.barbox.setAttribute('aria-valuetext', v + '% 解答済み');
  }
}

function updateChrome(q, st){
  const answered = Object.values(state).filter(s => s.graded).length;
  const right = Object.values(state).filter(s => s.graded && s.correct).length;
  el.score.textContent = `解答 ${answered} / ${list.length}　正解 ${right}`;
  // バーは「現在位置」ではなく「解答が済んだ割合」を表す
  setProgress(list.length ? (answered / list.length) * 100 : 0);
  el.prev.disabled = idx === 0;
  el.check.disabled = !q || (st && st.graded) || (q && q.type === 'ox');
  el.next.disabled = false;
  el.next.textContent = idx === list.length - 1 ? '結果を見る' : '次へ';
}

/* ===================== 採点 ===================== */
function warn(msg){
  const box = document.getElementById('result');
  if (box) box.innerHTML = `<div class="warn">${esc(msg)}</div>`;
}
function clearWarn(){
  const box = document.getElementById('result');
  if (box && box.querySelector('.warn')) box.innerHTML = '';
}

function grade(){
  const q = list[idx];
  if (!q) return;
  const st = state[q.id];
  if (!st || st.graded) return;
  if (q.type === 'fill'){
    const labels = labelsOf(q);
    // 空欄が 1 つもない問題を every() で「全問正解」にしてしまわないようにする
    if (!labels.length){
      warn('この問題には空欄がありません。questions.js の [[1]] の書き方を確認してください。');
      return;
    }
    // 全部未入力のまま Enter を押した誤操作で不正解が確定しないようにする
    if (labels.every(n => norm(st.vals[n]) === '')){
      warn('空欄が未入力です。ひとつでも入力すると答え合わせできます。');
      const first = document.querySelector('input.blank:not([disabled])');
      if (first) first.focus();
      return;
    }
    st.correct = labels.every(n => isCorrectBlank(q.answers[n], st.vals[n]));
  } else {
    if (!st.choice) return;
    st.correct = st.choice === q.answer;
  }
  st.graded = true;
  // 1 問につき 1 回だけ成績に数える。答えを見てからの「やり直す」は連続正解に含めない
  if (!counted.has(q.id)){
    counted.add(q.id);
    record(q, st.correct);
  }
  render();
}

/* 採点結果を捨てて、この問題をもう一度解き直す */
function retry(){
  const q = list[idx];
  if (!q) return;
  state[q.id] = { vals: {}, choice: null, graded: false, correct: false };
  render();
}

/* ===================== 結果画面 ===================== */
/* 項目ごとの誤答率。記録がある項目だけを、苦手な順に並べる */
function renderCatTable(){
  const rows = [...catStats().entries()]
    .map(([cat, c]) => ({ cat, ...c, pct: c.wrong / c.asked }))
    .sort((a, b) => (b.pct - a.pct) || (b.wrong - a.wrong) || a.cat.localeCompare(b.cat, 'ja'));
  if (!rows.length) return '';
  return '<div class="sechead">項目ごとの成績（通算）</div>' +
    '<table class="cats"><thead><tr><th>項目</th><th class="num">誤答</th>' +
    '<th class="num">解答</th><th class="num">誤答率</th></tr></thead><tbody>' +
    rows.map(r => {
      const pct = Math.round(r.pct * 100);
      return `<tr class="${pct >= 50 ? 'hot' : ''}"><td>${esc(r.cat)}</td>` +
             `<td class="num">${r.wrong}</td><td class="num">${r.asked}</td>` +
             `<td class="num">${pct}%</td></tr>`;
    }).join('') + '</tbody></table>';
}

/* 復習リストの中身と、そこから外す操作 */
function renderReviewList(){
  const rv = reviewQuestions();
  if (!rv.length) return '<div class="sechead">復習リスト</div><div class="sub">いまは空です。</div>';
  return '<div class="sechead">復習リスト（' + rv.length + '問）</div><ul class="reviews">' +
    rv.map(q => {
      const s = stats[q.id];
      const note = isStubborn(q.id)
        ? `通算${s.wrong}回ミス・自動では外れません`
        : `連続正解 ${s.streak} / ${REVIEW_STREAK}`;
      return `<li><span class="t">${esc(q.title)}</span>` +
             `<span class="c">${esc(q.cat)}</span><span class="w">${esc(note)}</span>` +
             `<button class="drop" data-drop="${esc(q.id)}">外す</button></li>`;
    }).join('') + '</ul>';
}

function renderFinal(){
  // 復習リストが空のまま選ばれたときは、成績だけ見せて空だと伝える
  if (!list.length){
    el.main.innerHTML = `
      <div class="meta"><span class="tag">結果</span></div>
      <section class="card final">
        <h2>出題できる問題がありません</h2>
        <div class="sub">${el.scope.value === 'review'
          ? '復習リストは空です。ほかの範囲を解いて、間違えた問題がたまると自動で入ります。'
          : 'この範囲に問題がありません。出題範囲を選び直してください。'}</div>
        ${renderCatTable()}
      </section>`;
    setProgress(0);
    el.prev.disabled = true;
    el.check.disabled = true;
    el.next.disabled = true;
    el.next.textContent = '次へ';
    return;
  }

  const done = list.filter(q => state[q.id] && state[q.id].graded);
  const right = done.filter(q => state[q.id].correct);
  const wrong = done.filter(q => !state[q.id].correct);
  const skipped = list.length - done.length;
  // 分母は出題数。飛ばした問題を除いて率を出すと、実力より高く見えてしまう
  const pct = list.length ? Math.round(right.length / list.length * 100) : 0;
  const pctDone = done.length ? Math.round(right.length / done.length * 100) : 0;

  el.main.innerHTML = `
    <div class="meta"><span class="tag">結果</span></div>
    <section class="card final">
      <h2>おつかれさまでした</h2>
      <div class="big">${right.length} / ${list.length}<span style="font-size:1rem"> 問正解（${pct}%）</span></div>
      <div class="sub">${skipped > 0
        ? '未解答 ' + skipped + '問（解答した ' + done.length + '問のなかでは ' + pctDone + '%）'
        : '全問に解答しました'}</div>
      ${wrong.length ? '<div style="font-size:.9rem;font-weight:600;margin-bottom:6px">間違えた問題</div><ul class="wrongs">' +
        wrong.map(q => `<li><button data-id="${esc(q.id)}">${esc(q.title)}　<span style="color:var(--ink-soft)">${esc(q.cat)}</span></button></li>`).join('') +
        '</ul>' : ''}
      <div class="acts">
        ${wrong.length ? '<button class="btn primary" id="again-wrong" style="flex:0 0 auto">間違えた問題だけ復習する</button>' : ''}
        <button class="btn" id="again-all">同じ範囲をもう一度</button>
        ${reviewQuestions().length ? '<button class="btn" id="again-review">復習リストを解く</button>' : ''}
      </div>
      <div style="margin-top:28px;padding-top:22px;border-top:1px solid var(--rule)">
        ${renderReviewList()}
        ${renderCatTable()}
      </div>
    </section>`;

  el.main.querySelectorAll('.wrongs button').forEach(b => {
    b.addEventListener('click', () => { idx = list.findIndex(q => q.id === b.dataset.id); render(); });
  });
  el.main.querySelectorAll('button[data-drop]').forEach(b => {
    b.addEventListener('click', () => { dropFromReview(b.dataset.drop); renderFinal(); });
  });
  const aw = document.getElementById('again-wrong');
  if (aw) aw.addEventListener('click', () => start(wrong));
  document.getElementById('again-all').addEventListener('click', () => start(list));
  const ar = document.getElementById('again-review');
  if (ar) ar.addEventListener('click', () => {
    el.scope.value = savedScope = 'review';
    start(reviewQuestions());
  });

  setProgress(list.length ? (done.length / list.length) * 100 : 0);
  el.prev.disabled = list.length === 0;
  el.check.disabled = true;
  el.next.disabled = true;
  el.next.textContent = '次へ';
}

/* ===================== 操作 ===================== */
el.check.addEventListener('click', grade);
el.next.addEventListener('click', () => { if (idx < list.length){ idx++; render(); } });
el.prev.addEventListener('click', () => { if (idx > 0){ idx--; render(); } });
/* 解答済みがあるときだけ確認する（設定変更で成績が消えるのは分かりにくいため） */
function restartWith(questions, why){
  const answered = Object.values(state).filter(s => s.graded).length;
  if (answered && !confirm(why + '\n解答済みの ' + answered + '問はリセットされます。よろしいですか？')){
    return false;
  }
  start(questions);
  return true;
}
el.restart.addEventListener('click', () => restartWith(selectQuestions(), '最初から始めます。'));
el.resetStats.addEventListener('click', resetStats);
el.scope.addEventListener('change', () => {
  if (!restartWith(selectQuestions(), '出題範囲を変更します。')) el.scope.value = savedScope;
  savedScope = el.scope.value;
});
el.shuffle.addEventListener('change', () => {
  if (!restartWith(selectQuestions(), '出題順の設定を変更します。')) el.shuffle.checked = !el.shuffle.checked;
});
el.hint.addEventListener('change', () => { applyBlankWidths(); save(); });

document.addEventListener('keydown', e => {
  const tag = e.target && e.target.tagName;
  // 入力欄・プルダウン・チェックボックスの上ではキー操作を奪わない
  const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  const mod = e.ctrlKey || e.altKey || e.metaKey;
  const q = list[idx];
  const st = q ? state[q.id] : null;

  if (e.key === 'Enter' && !mod){
    if (q && st && !st.graded && q.type === 'fill'){ e.preventDefault(); grade(); }
    else if (!el.next.disabled){ e.preventDefault(); el.next.click(); }
    return;
  }

  // 問題の移動：入力欄の外では矢印そのまま、空欄の入力中は Ctrl／Alt 併用
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
    if (inField && !mod) return;          // カーソル移動・プルダウン操作を邪魔しない
    if (e.key === 'ArrowRight' && !el.next.disabled){ e.preventDefault(); el.next.click(); }
    if (e.key === 'ArrowLeft'  && !el.prev.disabled){ e.preventDefault(); el.prev.click(); }
    return;
  }

  if (inField || mod) return;

  if (q && q.type === 'ox' && st && !st.graded){
    if (e.key === 'o' || e.key === '1'){ e.preventDefault(); st.choice = '○'; grade(); }
    if (e.key === 'x' || e.key === '2'){ e.preventDefault(); st.choice = '×'; grade(); }
  }
});

/* ===================== 起動 ===================== */
reportIssues(validateQuestions());
loadStats();          // 復習リストの件数を出すので、出題範囲を組み立てる前に読む
buildScope();
const saved = loadSaved();
restoreSettings(saved);
if (!restoreProgress(saved)){
  clearSaved();                            // 問題データが変わっている場合は破棄して作り直す
  start(selectQuestions());
}
