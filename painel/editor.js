/**
 * painel/editor.js — Editor do mapa (área administrativa do BuzuRota).
 *
 * Feito para computador: mapa grande no centro, lista à esquerda, propriedades à direita.
 * Usa as mesmas funções de dados do site (js/dados.js): toda alteração vai para o RASCUNHO
 * (IndexedDB deste navegador) e só chega ao site quando alguém clica em "Publicar".
 *
 * Traçados: cada linha tem IDA e VOLTA editadas separadamente. No arquivo, a geometria é
 * [...ida, ...volta], com indice_retorno = último ponto da ida, e as cópias
 * coordenadas_ida / coordenadas_volta / pontos_guia_* ficam sempre sincronizadas.
 */
(function () {
  'use strict';

  window.BUZU_MODO_EDITOR = true; // dados.js: carrega traçados completos (sem simplificar)

  const D = window.BuzuDados;
  const U = window.BuzuUtils;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  // ------------------------------------------------------------------ utilitários
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  const clone = v => JSON.parse(JSON.stringify(v || []));
  const fmtNum = n => Number(n || 0).toLocaleString('pt-BR');
  const fmtKm = m => `${(m / 1000).toFixed(2).replace('.', ',')} km`;
  const fmtM = m => (m >= 1000 ? fmtKm(m) : `${Math.round(m)} m`);
  const arred = v => Number(Number(v).toFixed(6));
  const coordValida = c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
  const distM = (a, b) => U.calcularDistanciaGeodesica(a[1], a[0], b[1], b[0]);
  function comprimento(coords) {
    let t = 0;
    for (let i = 1; i < coords.length; i++) t += distM(coords[i - 1], coords[i]);
    return t;
  }
  function misturarCor(hex, fracao) {
    const n = String(hex || '#162652').replace('#', '');
    const rgb = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
    return '#' + rgb.map(v => Math.round(v + (255 - v) * fracao).toString(16).padStart(2, '0')).join('');
  }
  function corClara(hex) {
    const n = String(hex || '').replace('#', '');
    if (n.length < 6) return false;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62;
  }

  function toast(msg, erro = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${erro ? ' toast--erro' : ''}`;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), erro ? 6000 : 3800);
  }

  function baixar(nome, conteudo, tipo) {
    const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ------------------------------------------------------------------ preferências
  const CHAVE_PREFS = 'buzu_editor_prefs';
  const PADRAO = {
    fundo: '',
    opacFundo: 100,
    verLinhas: true,
    corLinhas: 'linha',
    opacLinhas: 45,
    verParadas: true,
    paradasSempre: false,
    verInativas: true,
    verNomes: false,
    verSetas: true,
    verOrdem: true,
    espessura: 6
  };
  let prefs = { ...PADRAO };
  try {
    prefs = { ...PADRAO, ...JSON.parse(localStorage.getItem(CHAVE_PREFS) || '{}') };
  } catch (_e) {}
  function salvarPrefs() {
    try {
      localStorage.setItem(CHAVE_PREFS, JSON.stringify(prefs));
    } catch (_e) {}
  }

  let tema = 'claro';
  try {
    tema = localStorage.getItem('buzu_tema') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro');
  } catch (_e) {}
  function aplicarTema() {
    document.documentElement.setAttribute('data-tema', tema);
    const i = $('#ed-tema i');
    if (i) i.className = tema === 'escuro' ? 'bi bi-sun' : 'bi bi-moon-stars';
  }
  aplicarTema();
  if (!prefs.fundo) prefs.fundo = tema === 'escuro' ? 'escuro' : 'claro';

  // ------------------------------------------------------------------ estado
  const S = {
    dia: 'dias_uteis_sabados',
    ferramenta: 'selecionar',
    sel: null, // { tipo: 'linha', numero } | { tipo: 'parada', id }
    abaEsq: 'linhas',
    subaba: 'tracado',
    problemas: [],
    medida: []
  };
  let ed = null; // sessão de edição do traçado da linha selecionada

  const E = () => D.obterEstado();
  const linhas = () => E().indice?.linhas || [];
  const paradas = () => E().paradas?.features || [];
  function todasFeatures() {
    const c = E().cacheGeoJsonLotes || {};
    return [...(c['1']?.features || []), ...(c['2']?.features || [])];
  }
  const numeroDe = f => String(f?.properties?.numero || f?.properties?.linha_id || '').toUpperCase();
  const doDia = (f, dia = S.dia) => !f.properties?.dia_semana || f.properties.dia_semana === 'todos' || f.properties.dia_semana === dia;
  function featuresDoDia(dia = S.dia) {
    return todasFeatures().filter(f => f.geometry?.type === 'LineString' && (f.geometry.coordinates || []).length > 1 && doDia(f, dia));
  }
  const featureDe = (numero, dia = S.dia) => todasFeatures().find(f => numeroDe(f) === numero && doDia(f, dia));
  const linhaDe = numero => linhas().find(l => String(l.numero).toUpperCase() === numero);
  const corDe = obj => (/^#[0-9a-f]{6}$/i.test(String(obj?.cor || '')) ? obj.cor : '#162652');
  const paradaDe = id => paradas().find(f => String(f.properties?.id) === String(id));
  const vinculosLinha = (numero, dia = S.dia) =>
    (E().linhaParadas || []).filter(lp => String(lp.linha_id).toUpperCase() === numero && (lp.dia_semana === dia || lp.dia_semana === 'todos'));
  const vinculosParada = id => (E().linhaParadas || []).filter(lp => String(lp.parada_id) === String(id));

  /** Separa ida e volta de uma feature (usa as cópias salvas quando batem com a geometria) */
  function separarSentidos(f) {
    if (!f) return { ida: [], volta: [] };
    const p = f.properties || {};
    const g = (f.geometry?.coordinates || []).filter(coordValida);
    const ida = p.coordenadas_ida;
    const volta = p.coordenadas_volta;
    if (Array.isArray(ida) && Array.isArray(volta) && ida.length > 1 && ida.length + volta.length === g.length) {
      const ultima = g[g.length - 1];
      const fimVolta = volta.length ? volta[volta.length - 1] : ida[ida.length - 1];
      if (ultima && fimVolta && ultima[0] === fimVolta[0] && ultima[1] === fimVolta[1]) return { ida: clone(ida), volta: clone(volta) };
    }
    const r = Number(p.indice_retorno);
    if (Number.isInteger(r) && r > 0 && r < g.length - 1) return { ida: clone(g.slice(0, r + 1)), volta: clone(g.slice(r + 1)) };
    return { ida: clone(g), volta: [] };
  }

  // ------------------------------------------------------------------ mapa
  let mapa;
  let camadaFundo = null;
  const G = {};
  const R = {};
  let polySel = {};

  function montarMapa() {
    mapa = L.map('ed-mapa', {
      center: [-5.79, -35.225],
      zoom: 12,
      maxZoom: 20,
      zoomControl: false,
      preferCanvas: true,
      boxZoom: true
    });
    L.control.zoom({ position: 'topright' }).addTo(mapa);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(mapa);

    const pane = (nome, z) => {
      mapa.createPane(nome);
      mapa.getPane(nome).style.zIndex = z;
    };
    pane('pFantasma', 405);
    pane('pSel', 415);
    pane('pParadas', 430);
    pane('pSetas', 610);
    pane('pEdicao', 640);
    R.fantasma = L.canvas({ pane: 'pFantasma', padding: 0.4, tolerance: 6 });
    R.sel = L.canvas({ pane: 'pSel', padding: 0.4, tolerance: 8 });
    R.paradas = L.canvas({ pane: 'pParadas', padding: 0.3, tolerance: 4 });
    for (const nome of ['fantasma', 'sel', 'paradas', 'setas', 'edicao', 'medida', 'temp']) G[nome] = L.layerGroup().addTo(mapa);

    aplicarFundo();

    mapa.on('click', aoClicarMapa);
    mapa.on('mousemove', e => {
      $('#ed-coord').textContent = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
    });
    mapa.on('zoomend', () => {
      $('#ed-zoom').textContent = `Zoom ${mapa.getZoom()}`;
      renderSelecao();
    });
    mapa.on('moveend', () => {
      renderParadas();
      renderEdicao();
    });
    mapa.getContainer().addEventListener('contextmenu', e => e.preventDefault());
    $('#ed-zoom').textContent = `Zoom ${mapa.getZoom()}`;
  }

  function aplicarFundo() {
    if (camadaFundo) mapa.removeLayer(camadaFundo);
    camadaFundo = null;
    const f = prefs.fundo;
    const creditoOfm = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © OpenMapTiles © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
    if ((f === 'claro' || f === 'escuro') && typeof L.maplibreGL === 'function') {
      camadaFundo = L.maplibreGL({
        style: f === 'escuro' ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/positron',
        attribution: creditoOfm
      });
    } else if (f === 'osm' || f === 'claro' || f === 'escuro') {
      camadaFundo = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19,
        maxZoom: 20,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
      });
    } else if (f === 'satelite') {
      camadaFundo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 19,
        maxZoom: 20,
        attribution: 'Imagens © Esri, Maxar, Earthstar Geographics'
      });
    }
    if (camadaFundo) {
      camadaFundo.addTo(mapa);
      aplicarOpacidadeFundo();
    }
  }

  function aplicarOpacidadeFundo() {
    if (!camadaFundo) return;
    const o = prefs.opacFundo / 100;
    if (typeof camadaFundo.setOpacity === 'function') camadaFundo.setOpacity(o);
    const c = typeof camadaFundo.getContainer === 'function' ? camadaFundo.getContainer() : null;
    if (c) c.style.opacity = String(o);
  }

  // ---------- outras linhas (fundo) ----------
  function renderFantasma() {
    G.fantasma.clearLayers();
    if (!prefs.verLinhas) return;
    const selNum = S.sel?.tipo === 'linha' ? S.sel.numero : null;
    for (const f of featuresDoDia()) {
      const num = numeroDe(f);
      if (num === selNum) continue;
      const l = linhaDe(num);
      const lote = String(f.properties.lote || l?.lote || '1');
      const cor = prefs.corLinhas === 'cinza' ? '#64748b' : prefs.corLinhas === 'lote' ? (lote === '2' ? '#D9531E' : '#0057B8') : corDe(l || f.properties);
      const pl = L.polyline(
        f.geometry.coordinates.filter(coordValida).map(c => [c[1], c[0]]),
        { renderer: R.fantasma, color: cor, weight: selNum ? 2.5 : 3, opacity: (prefs.opacLinhas / 100) * (selNum ? 0.75 : 1), lineJoin: 'round' }
      );
      pl.bindTooltip(`<strong>${esc(num)}</strong> — ${esc(l?.nome || f.properties.nome || '')}`, { sticky: true });
      pl.on('click', e => {
        if (S.ferramenta !== 'selecionar') return;
        L.DomEvent.stop(e);
        selecionarLinha(num);
      });
      pl.addTo(G.fantasma);
    }
  }

  // ---------- paradas ----------
  const CORES_PARADA = { terminal: '#162652', integracao: '#ea580c', parada: '#16a34a', inativa: '#94a3b8' };
  function tipoParada(p) {
    const t = String(p.tipo || '').toLowerCase();
    if (t.includes('terminal')) return 'terminal';
    if (t.includes('integra') || t.includes('estação')) return 'integracao';
    return 'parada';
  }

  function renderParadas() {
    G.paradas.clearLayers();
    if (!mapa || !prefs.verParadas) return;
    const zoom = mapa.getZoom();
    if (!prefs.paradasSempre && zoom < 14) return;
    const limites = mapa.getBounds().pad(0.25);
    const ligadas = new Map();
    let corSel = null;
    if (S.sel?.tipo === 'linha') {
      corSel = corDe(linhaDe(S.sel.numero));
      for (const v of vinculosLinha(S.sel.numero)) ligadas.set(String(v.parada_id), v);
    }
    const nomes = prefs.verNomes && zoom >= 18;
    for (const f of paradas()) {
      const p = f.properties || {};
      const inativa = p.ativo === false;
      if (inativa && !prefs.verInativas) continue;
      const c = f.geometry?.coordinates;
      if (!coordValida(c) || !limites.contains([c[1], c[0]])) continue;
      if (S.sel?.tipo === 'parada' && String(p.id) === String(S.sel.id)) continue; // desenhada como marcador arrastável
      const tipo = tipoParada(p);
      const ligada = ligadas.has(String(p.id));
      const raio = tipo === 'terminal' ? 7 : tipo === 'integracao' ? 6 : ligada ? 5.5 : zoom >= 16 ? 5 : 4;
      const m = L.circleMarker([c[1], c[0]], {
        renderer: R.paradas,
        radius: raio,
        color: inativa ? CORES_PARADA.inativa : '#ffffff',
        weight: inativa ? 2 : 1.5,
        fillColor: inativa ? '#ffffff' : ligada ? corSel : CORES_PARADA[tipo],
        fillOpacity: inativa ? 0.6 : 1,
        dashArray: inativa ? '2,2' : null
      });
      if (nomes) {
        m.bindTooltip(esc(p.nome), { permanent: true, direction: 'right', offset: [6, 0], className: 'ed-rotulo-parada' });
      } else {
        m.bindTooltip(`<strong>${esc(p.nome)}</strong><br><small>${esc(p.id)}${inativa ? ' • inativa' : ''}</small>`, { direction: 'top' });
      }
      m.on('click', e => {
        if (S.ferramenta !== 'selecionar') return;
        L.DomEvent.stop(e);
        selecionarParada(p.id);
      });
      m.addTo(G.paradas);
    }
    // parada selecionada: marcador arrastável
    if (S.sel?.tipo === 'parada') {
      const f = paradaDe(S.sel.id);
      if (f && coordValida(f.geometry?.coordinates)) {
        const [lng, lat] = f.geometry.coordinates;
        const mk = L.marker([lat, lng], {
          draggable: true,
          icon: L.divIcon({ className: 'ed-parada-sel', iconSize: [26, 26] }),
          title: 'Arraste para mover a parada',
          zIndexOffset: 1000
        });
        mk.on('dragend', async () => {
          const ll = mk.getLatLng();
          await D.moverParadaNoMapa(S.sel.id, ll.lat, ll.lng, true);
          toast('Parada movida. Vínculos com as linhas recalculados.');
          depoisDeAlterarDados();
        });
        mk.addTo(G.paradas);
      }
    }
  }

  // ---------- linha selecionada ----------
  function coordsAtuais(sentido) {
    if (ed && S.sel?.tipo === 'linha' && ed.numero === S.sel.numero) return ed[sentido];
    return separarSentidos(featureDe(S.sel?.numero))[sentido];
  }

  function renderSelecao() {
    G.sel.clearLayers();
    G.setas.clearLayers();
    polySel = {};
    if (S.sel?.tipo !== 'linha') return;
    const l = linhaDe(S.sel.numero);
    const cor = corDe(l);
    const corVolta = misturarCor(cor, 0.5);
    const editando = ['vertices', 'desenhar', 'rotear'].includes(S.ferramenta);
    const w = Number(prefs.espessura) || 6;
    for (const sentido of ['volta', 'ida']) {
      const ll = coordsAtuais(sentido).filter(coordValida).map(c => [c[1], c[0]]);
      const ativo = !editando || !ed || ed.alvo === sentido;
      const corS = sentido === 'ida' ? cor : corVolta;
      polySel[`cas_${sentido}`] = L.polyline(ll, { renderer: R.sel, color: tema === 'escuro' ? '#0b1220' : '#ffffff', weight: w + 4, opacity: ativo ? 0.95 : 0.4, interactive: false, lineJoin: 'round' }).addTo(G.sel);
      polySel[sentido] = L.polyline(ll, { renderer: R.sel, color: corS, weight: w, opacity: ativo ? 1 : 0.35, lineJoin: 'round', lineCap: 'round' })
        .bindTooltip(sentido === 'ida' ? 'IDA (terminal → retorno)' : 'VOLTA (retorno → terminal)', { sticky: true })
        .on('click', e => {
          if (S.ferramenta !== 'selecionar' && S.ferramenta !== 'vertices') return;
          L.DomEvent.stop(e);
          definirAlvo(sentido);
        })
        .addTo(G.sel);
      if (prefs.verSetas) desenharSetas(ll, corS);
    }
    const ida = coordsAtuais('ida');
    if (ida.length) {
      ponta(ida[0], '<i class="bi bi-flag-fill"></i> Terminal', 'ed-ponta--inicio');
      ponta(ida[ida.length - 1], '<i class="bi bi-arrow-return-left"></i> Retorno', 'ed-ponta--retorno');
    }
    if (prefs.verOrdem && mapa.getZoom() >= 15) {
      for (const v of vinculosLinha(S.sel.numero)) {
        const f = paradaDe(v.parada_id);
        if (!f || !coordValida(f.geometry?.coordinates)) continue;
        const [lng, lat] = f.geometry.coordinates;
        const corO = v.sentido === 'VOLTA' ? misturarCor(cor, 0.35) : cor;
        L.marker([lat, lng], {
          interactive: false,
          keyboard: false,
          pane: 'pSetas',
          icon: L.divIcon({ className: '', html: `<span class="ed-ordem" style="--cor-o:${corO}">${v.sentido === 'VOLTA' ? 'V' : ''}${v.ordem_sequencial}</span>`, iconSize: null })
        }).addTo(G.setas);
      }
    }
  }

  function ponta(c, html, classe) {
    L.marker([c[1], c[0]], {
      interactive: false,
      keyboard: false,
      pane: 'pSetas',
      icon: L.divIcon({ className: '', html: `<span class="ed-ponta ${classe}">${html}</span>`, iconSize: null })
    }).addTo(G.setas);
  }

  function desenharSetas(latLngs, cor) {
    if (latLngs.length < 2) return;
    const pts = latLngs.map(ll => mapa.latLngToLayerPoint(ll));
    const ESPACO = 110;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += pts[i - 1].distanceTo(pts[i]);
    let acum = total < ESPACO ? total / 2 : ESPACO / 2;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = a.distanceTo(b);
      while (acum <= seg && seg > 0) {
        const t = acum / seg;
        const p = L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        L.marker(mapa.layerPointToLatLng(p), {
          interactive: false,
          keyboard: false,
          pane: 'pSetas',
          icon: L.divIcon({ className: '', html: `<div class="ed-seta" style="--cor-seta:${cor};transform:rotate(${ang}deg)">➤</div>`, iconSize: [16, 16], iconAnchor: [8, 8] })
        }).addTo(G.setas);
        acum += ESPACO;
      }
      acum -= seg;
    }
  }

  // ---------- alças de edição ----------
  function atualizarPolilinhaAtiva() {
    if (!ed) return;
    const ll = ed[ed.alvo].filter(coordValida).map(c => [c[1], c[0]]);
    polySel[ed.alvo]?.setLatLngs(ll);
    polySel[`cas_${ed.alvo}`]?.setLatLngs(ll);
  }

  function renderEdicao() {
    G.edicao.clearLayers();
    if (!ed || S.sel?.tipo !== 'linha' || ed.numero !== S.sel.numero) return;
    const corV = ed.alvo === 'ida' ? corDe(linhaDe(ed.numero)) : misturarCor(corDe(linhaDe(ed.numero)), 0.35);
    if (S.ferramenta === 'vertices') {
      const coords = ed[ed.alvo];
      const limites = mapa.getBounds().pad(0.1);
      const visiveis = [];
      coords.forEach((c, i) => {
        if (coordValida(c) && limites.contains([c[1], c[0]])) visiveis.push(i);
      });
      if (visiveis.length > 700) {
        dicaTemporaria(`Aproxime o mapa para editar os pontos (${fmtNum(visiveis.length)} pontos na tela).`);
        return;
      }
      const vis = new Set(visiveis);
      for (const i of visiveis) {
        const c = coords[i];
        const ehPonta = i === 0 || i === coords.length - 1;
        const mk = L.marker([c[1], c[0]], {
          draggable: true,
          pane: 'pEdicao',
          keyboard: false,
          title: `Ponto ${i + 1} de ${coords.length} — arraste para mover, botão direito apaga`,
          icon: L.divIcon({ className: `ed-vertice${ehPonta ? ' ed-vertice--ponta' : ''}${ed.verticeSel === i ? ' ed-vertice--sel' : ''}`, html: '', iconSize: [12, 12] })
        });
        mk.getElement?.();
        mk.on('add', () => mk.getElement()?.style.setProperty('--cor-v', corV));
        mk.on('dragstart', () => registrarPasso());
        mk.on('drag', ev => {
          const ll = ev.target.getLatLng();
          ed[ed.alvo][i] = [arred(ll.lng), arred(ll.lat)];
          atualizarPolilinhaAtiva();
        });
        mk.on('dragend', () => geometriaAlterada());
        mk.on('click', ev => {
          L.DomEvent.stop(ev);
          ed.verticeSel = i;
          renderEdicao();
        });
        mk.on('contextmenu', ev => {
          L.DomEvent.stop(ev);
          removerVertice(i);
        });
        mk.addTo(G.edicao);
      }
      if (mapa.getZoom() >= 15) {
        for (const i of visiveis) {
          if (i >= coords.length - 1 || !vis.has(i + 1)) continue;
          const a = coords[i];
          const b = coords[i + 1];
          const meio = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const mk = L.marker([meio[1], meio[0]], {
            draggable: true,
            pane: 'pEdicao',
            keyboard: false,
            title: 'Arraste para criar um ponto aqui',
            icon: L.divIcon({ className: 'ed-meio', html: '', iconSize: [10, 10] })
          });
          mk.on('add', () => mk.getElement()?.style.setProperty('--cor-v', corV));
          let idxNovo = -1;
          mk.on('dragstart', () => {
            registrarPasso();
            ed[ed.alvo].splice(i + 1, 0, meio.slice());
            idxNovo = i + 1;
          });
          mk.on('drag', ev => {
            const ll = ev.target.getLatLng();
            ed[ed.alvo][idxNovo] = [arred(ll.lng), arred(ll.lat)];
            atualizarPolilinhaAtiva();
          });
          mk.on('dragend', () => geometriaAlterada());
          mk.addTo(G.edicao);
        }
      }
    }
    if (S.ferramenta === 'rotear') {
      ed.guia[ed.alvo].forEach((c, k) => {
        const mk = L.marker([c[1], c[0]], {
          draggable: true,
          pane: 'pEdicao',
          title: `Ponto-guia ${k + 1} — arraste para ajustar, botão direito remove`,
          icon: L.divIcon({ className: 'ed-guia', html: String(k + 1), iconSize: [22, 22] })
        });
        mk.on('dragstart', () => registrarPasso());
        mk.on('dragend', ev => {
          const ll = ev.target.getLatLng();
          ed.guia[ed.alvo][k] = [arred(ll.lng), arred(ll.lat)];
          rotear();
        });
        mk.on('contextmenu', ev => {
          L.DomEvent.stop(ev);
          registrarPasso();
          ed.guia[ed.alvo].splice(k, 1);
          rotear();
        });
        mk.addTo(G.edicao);
      });
    }
  }

  // ------------------------------------------------------------------ sessão de edição do traçado
  function abrirSessao(numero, manterAlvo = true) {
    const f = featureDe(numero);
    const s = separarSentidos(f);
    const p = f?.properties || {};
    ed = {
      numero,
      dia: S.dia,
      ida: s.ida,
      volta: s.volta,
      guia: { ida: clone(p.pontos_guia_ida), volta: clone(p.pontos_guia_volta) },
      alvo: manterAlvo && ed?.numero === numero ? ed.alvo : 'ida',
      sujo: false,
      pilha: [],
      refazer: [],
      verticeSel: null
    };
  }

  function confirmarDescarteSessao() {
    if (!ed?.sujo) return true;
    return confirm(`O traçado da linha ${ed.numero} tem alterações que ainda não foram salvas no rascunho.\n\nDescartar essas alterações?`);
  }

  function registrarPasso() {
    if (!ed) return;
    ed.pilha.push(JSON.stringify({ ida: ed.ida, volta: ed.volta, guia: ed.guia }));
    if (ed.pilha.length > 150) ed.pilha.shift();
    ed.refazer = [];
  }

  function geometriaAlterada() {
    if (!ed) return;
    ed.sujo = true;
    renderSelecao();
    renderEdicao();
    renderInspetor();
  }

  function desfazerTracado() {
    if (!ed?.pilha.length) return false;
    ed.refazer.push(JSON.stringify({ ida: ed.ida, volta: ed.volta, guia: ed.guia }));
    Object.assign(ed, JSON.parse(ed.pilha.pop()));
    ed.sujo = true;
    geometriaAlterada();
    return true;
  }

  function refazerTracado() {
    if (!ed?.refazer.length) return false;
    ed.pilha.push(JSON.stringify({ ida: ed.ida, volta: ed.volta, guia: ed.guia }));
    Object.assign(ed, JSON.parse(ed.refazer.pop()));
    geometriaAlterada();
    return true;
  }

  function removerVertice(i) {
    if (!ed) return;
    registrarPasso();
    ed[ed.alvo].splice(i, 1);
    ed.verticeSel = null;
    geometriaAlterada();
  }

  function definirAlvo(sentido) {
    if (!ed) return;
    ed.alvo = sentido;
    ed.verticeSel = null;
    renderSelecao();
    renderEdicao();
    renderInspetor();
    atualizarDica();
  }

  function guiasDoTracado(coords) {
    if (coords.length < 2) return clone(coords);
    const total = comprimento(coords);
    const passo = Math.max(400, total / 22);
    const guias = [coords[0]];
    let acum = 0;
    for (let i = 1; i < coords.length - 1; i++) {
      acum += distM(coords[i - 1], coords[i]);
      if (acum >= passo) {
        guias.push(coords[i]);
        acum = 0;
      }
    }
    guias.push(coords[coords.length - 1]);
    return clone(guias);
  }

  let timerRota = null;
  let seqRota = 0;
  function rotear() {
    renderEdicao();
    clearTimeout(timerRota);
    timerRota = setTimeout(executarRota, 350);
  }

  async function executarRota() {
    if (!ed) return;
    const guias = ed.guia[ed.alvo].filter(coordValida);
    const alvo = ed.alvo;
    if (guias.length < 2) {
      ed[alvo] = clone(guias);
      geometriaAlterada();
      return;
    }
    const minha = ++seqRota;
    dicaTemporaria('Traçando pelas ruas…', 20000);
    try {
      let resultado = [];
      for (let i = 0; i < guias.length - 1; i += 24) {
        const grupo = guias.slice(i, i + 25);
        const url = `https://router.project-osrm.org/route/v1/driving/${grupo.map(c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`).join(';')}?overview=full&geometries=geojson&continue_straight=true`;
        const r = await fetch(url);
        const j = await r.json();
        if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || j.code || `HTTP ${r.status}`);
        const g = j.routes[0].geometry.coordinates.map(c => [arred(c[0]), arred(c[1])]);
        resultado = resultado.length ? resultado.concat(g.slice(1)) : g;
      }
      if (minha !== seqRota || !ed) return;
      ed[alvo] = resultado;
      geometriaAlterada();
      dicaTemporaria(`Traçado pelas ruas: ${fmtKm(comprimento(resultado))} em ${fmtNum(resultado.length)} pontos.`);
    } catch (err) {
      if (minha === seqRota) toast(`Não foi possível traçar pelas ruas (${err.message}). Tente de novo ou desenhe à mão.`, true);
    }
  }

  /**
   * Cor, lote e categoria vêm do cadastro da linha: salvar um traçado nunca muda esses dados
   * (a função de dados copia os do traçado para a linha quando eles não são informados).
   */
  function metaDaLinha(numero) {
    const l = linhaDe(numero);
    if (!l) return {};
    const meta = { cor: corDe(l), lote: String(l.lote || '1') };
    if (l.categoria_edital) meta.categoria_edital = l.categoria_edital;
    return meta;
  }

  async function salvarTracado() {
    if (!ed) return;
    const { numero, dia } = ed;
    const ida = ed.ida.filter(coordValida);
    const volta = ed.volta.filter(coordValida);
    if (ida.length === 1 || (!ida.length && volta.length)) {
      toast('A ida precisa de pelo menos 2 pontos.', true);
      return;
    }
    if (!ida.length && !confirm(`O traçado da linha ${numero} está vazio. Salvar assim remove o traçado deste dia. Continuar?`)) return;
    const coords = volta.length > 1 ? [...ida, ...volta] : ida;
    const meta = { ...metaDaLinha(numero), ...(volta.length > 1 ? { indice_retorno: ida.length - 1 } : {}) };
    const doMoovit = ed.importMoovit && coords.length ? ed.importMoovit : null;
    if (doMoovit) meta.itinerario_ruas = doMoovit.itinerario_ruas;
    ocupado(true, 'Salvando traçado e recalculando paradas…');
    try {
      // Paradas do Moovit que faltavam: entram antes de recalcular, para já ficarem ligadas à linha
      let criadas = 0;
      if (doMoovit?.paradasNovas?.length) {
        const lista = E().paradas.features;
        const bairroPerto = (lat, lng) => {
          let m = null;
          for (const f of lista) {
            const b = f.properties?.bairro;
            if (!b) continue;
            const [x, y] = f.geometry.coordinates;
            if (Math.abs(y - lat) > 0.01 || Math.abs(x - lng) > 0.01) continue;
            const d = U.calcularDistanciaGeodesica(lat, lng, y, x);
            if (!m || d < m.d) m = { d, b };
          }
          return m && m.d < 800 ? m.b : null;
        };
        for (const p of doMoovit.paradasNovas) {
          if (paradaDe(p.id)) continue; // já criada num import anterior
          lista.push({
            type: 'Feature',
            properties: {
              id: p.id,
              nome: p.nome,
              lat: p.lat,
              lng: p.lng,
              bairro: bairroPerto(p.lat, p.lng) || undefined,
              tipo: p.tipo,
              origem: 'moovit',
              ativo: true,
              acessivel: 'sim',
              sentidos_atendidos: p.sentido,
              rotas: [],
              dias_semana: [dia],
              dia_rotulo: DIAS[dia],
              integracoes_descricao: []
            },
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] }
          });
          criadas++;
        }
      }
      const res = await D.atualizarRotaNoMapa(numero, dia, coords, meta);
      const f = featureDe(numero, dia);
      if (f && coords.length) {
        f.properties.coordenadas_ida = ida;
        f.properties.coordenadas_volta = volta.length > 1 ? volta : [];
        f.properties.pontos_guia_ida = ed.guia.ida;
        f.properties.pontos_guia_volta = ed.guia.volta;
        if (doMoovit) {
          f.properties.fonte = 'Moovit';
          const variante = linhaDe(numero)?.variantes_dia?.[dia];
          if (variante) variante.fonte_rota = doMoovit.fonte_rota;
        } else if (f.properties.fonte === 'Moovit') {
          // traçado mexido à mão depois do import: deixa de ser cópia fiel do Moovit
          f.properties.fonte = 'Moovit (ajustado no editor)';
        }
        await D.salvarOverrideAdmin({ publicar: false, resumoAcao: doMoovit ? `Rota ${numero} (${dia}) importada do Moovit` : '' });
      }
      ed.importMoovit = null;
      ed.sujo = false;
      ed.pilha = [];
      ed.refazer = [];
      toast(
        res?.removida
          ? `Traçado da linha ${numero} removido deste dia (no rascunho).`
          : `Traçado salvo no rascunho: ${String(res.extensao_km).replace('.', ',')} km • ${res.paradasIda} paradas na ida e ${res.paradasVolta} na volta${
              criadas ? ` • ${criadas} parada(s) nova(s) do Moovit criadas` : ''
            }.`
      );
      depoisDeAlterarDados();
    } catch (err) {
      toast(`Erro ao salvar o traçado: ${err.message}`, true);
    } finally {
      ocupado(false);
    }
  }

  // ------------------------------------------------------------------ ferramentas
  const DICAS = {
    selecionar: '',
    vertices: () => `Editando a ${ed?.alvo === 'volta' ? 'VOLTA' : 'IDA'}: arraste os pontos • arraste os círculos do meio para criar ponto • botão direito ou Del apaga • 1/2 troca o sentido`,
    desenhar: () => `Clique para adicionar pontos no fim da ${ed?.alvo === 'volta' ? 'VOLTA' : 'IDA'} • Shift+clique adiciona no começo • Ctrl+Z desfaz`,
    rotear: () => `Pelas ruas (${ed?.alvo === 'volta' ? 'VOLTA' : 'IDA'}): clique para adicionar pontos-guia • Ctrl+clique insere no meio • arraste para ajustar • botão direito remove`,
    parada: 'Clique no mapa onde fica a nova parada',
    medir: 'Clique para medir distâncias • Esc limpa a medição'
  };

  function atualizarDica() {
    const d = DICAS[S.ferramenta];
    const texto = typeof d === 'function' ? d() : d;
    const el = $('#ed-dica-ferramenta');
    el.textContent = texto || '';
    el.hidden = !texto;
  }

  let timerDica = null;
  function dicaTemporaria(texto, ms = 3500) {
    const el = $('#ed-dica-ferramenta');
    el.textContent = texto;
    el.hidden = false;
    clearTimeout(timerDica);
    timerDica = setTimeout(atualizarDica, ms);
  }

  function definirFerramenta(f) {
    const deTracado = ['vertices', 'desenhar', 'rotear'].includes(f);
    if (deTracado && S.sel?.tipo !== 'linha') {
      toast('Selecione uma linha primeiro (na lista ou clicando no mapa).');
      return;
    }
    if (f !== 'medir') {
      S.medida = [];
      G.medida.clearLayers();
      $('#ed-medida').hidden = true;
    }
    S.ferramenta = f;
    $$('.ed-ferr').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ferramenta === f)));
    const mira = ['desenhar', 'rotear', 'parada', 'medir'].includes(f);
    mapa.getContainer().classList.toggle('ed-cursor-mira', mira);
    if (mira) mapa.doubleClickZoom.disable();
    else mapa.doubleClickZoom.enable();
    if (f === 'rotear' && ed && !ed.guia[ed.alvo].length && ed[ed.alvo].length > 1) {
      ed.guia[ed.alvo] = guiasDoTracado(ed[ed.alvo]);
      toast(`Criei ${ed.guia[ed.alvo].length} pontos-guia a partir do traçado atual. Arraste-os para ajustar.`);
    }
    if (deTracado) S.subaba = 'tracado';
    atualizarDica();
    renderSelecao();
    renderEdicao();
    renderInspetor();
  }

  async function aoClicarMapa(e) {
    const ll = [arred(e.latlng.lng), arred(e.latlng.lat)];
    const oe = e.originalEvent || {};
    if (S.ferramenta === 'desenhar' && ed) {
      registrarPasso();
      if (oe.shiftKey) ed[ed.alvo].unshift(ll);
      else ed[ed.alvo].push(ll);
      geometriaAlterada();
    } else if (S.ferramenta === 'rotear' && ed) {
      registrarPasso();
      const guias = ed.guia[ed.alvo];
      if ((oe.ctrlKey || oe.metaKey) && guias.length >= 2) {
        let melhor = guias.length;
        let menor = Infinity;
        for (let i = 0; i < guias.length - 1; i++) {
          const desvio = distM(guias[i], ll) + distM(ll, guias[i + 1]) - distM(guias[i], guias[i + 1]);
          if (desvio < menor) {
            menor = desvio;
            melhor = i + 1;
          }
        }
        guias.splice(melhor, 0, ll);
      } else {
        guias.push(ll);
      }
      rotear();
    } else if (S.ferramenta === 'parada') {
      await criarParadaEm(ll);
    } else if (S.ferramenta === 'medir') {
      S.medida.push(ll);
      renderMedida();
    } else if (S.ferramenta === 'vertices' && ed) {
      ed.verticeSel = null;
      renderEdicao();
    }
  }

  function renderMedida() {
    G.medida.clearLayers();
    const el = $('#ed-medida');
    if (!S.medida.length) {
      el.hidden = true;
      return;
    }
    const ll = S.medida.map(c => [c[1], c[0]]);
    L.polyline(ll, { color: '#e11d48', weight: 3, dashArray: '6,6', interactive: false }).addTo(G.medida);
    let acum = 0;
    S.medida.forEach((c, i) => {
      if (i) acum += distM(S.medida[i - 1], c);
      L.circleMarker([c[1], c[0]], { radius: 4, color: '#e11d48', fillColor: '#fff', fillOpacity: 1, weight: 2, interactive: false })
        .bindTooltip(i ? fmtM(acum) : 'início', { permanent: true, direction: 'top', offset: [0, -4] })
        .addTo(G.medida);
    });
    el.hidden = false;
    el.textContent = `Medida: ${fmtM(acum)}`;
  }

  // ------------------------------------------------------------------ seleção
  function selecionarLinha(numero, enquadrar = true) {
    numero = String(numero).toUpperCase();
    if (ed && ed.numero !== numero && !confirmarDescarteSessao()) return;
    S.sel = { tipo: 'linha', numero };
    if (!ed || ed.numero !== numero || ed.dia !== S.dia) abrirSessao(numero, false);
    renderTudo();
    if (enquadrar) enquadrarSelecao();
  }

  function selecionarParada(id, voar = false) {
    if (ed?.sujo && !confirmarDescarteSessao()) return;
    if (ed?.sujo) ed = null;
    if (['vertices', 'desenhar', 'rotear'].includes(S.ferramenta)) definirFerramenta('selecionar');
    S.sel = { tipo: 'parada', id: String(id) };
    renderTudo();
    if (voar) {
      const f = paradaDe(id);
      if (f) mapa.setView([f.geometry.coordinates[1], f.geometry.coordinates[0]], Math.max(mapa.getZoom(), 17));
    }
  }

  function limparSelecao() {
    if (ed?.sujo && !confirmarDescarteSessao()) return;
    S.sel = null;
    ed = null;
    if (S.ferramenta !== 'medir' && S.ferramenta !== 'parada') definirFerramenta('selecionar');
    renderTudo();
  }

  function enquadrarSelecao() {
    if (S.sel?.tipo === 'linha') {
      const pts = [...coordsAtuais('ida'), ...coordsAtuais('volta')].filter(coordValida).map(c => [c[1], c[0]]);
      if (pts.length) mapa.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
    } else if (S.sel?.tipo === 'parada') {
      const f = paradaDe(S.sel.id);
      if (f) mapa.setView([f.geometry.coordinates[1], f.geometry.coordinates[0]], 18);
    }
  }

  // ------------------------------------------------------------------ paradas: ações
  async function criarParadaEm(ll) {
    ocupado(true, 'Criando parada…');
    try {
      const feat = await D.criarOuEditarParadaNoMapa({
        lat: ll[1],
        lng: ll[0],
        nome: 'Nova parada',
        tipo: 'parada',
        origem: 'manual',
        ativo: true,
        sentidos_atendidos: 'AUTO'
      });
      definirFerramenta('selecionar');
      S.sel = { tipo: 'parada', id: String(feat.properties.id) };
      depoisDeAlterarDados();
      const nome = await sugerirNomeRua(ll);
      if (nome) {
        const campo = $('#pa-nome');
        if (campo && campo.value === 'Nova parada') {
          campo.value = nome.rua;
          if (nome.bairro && $('#pa-bairro') && !$('#pa-bairro').value) $('#pa-bairro').value = nome.bairro;
        }
      }
      $('#pa-nome')?.focus();
      $('#pa-nome')?.select();
      toast('Parada criada. Ajuste o nome e clique em "Salvar parada".');
    } catch (err) {
      toast(`Erro ao criar parada: ${err.message}`, true);
    } finally {
      ocupado(false);
    }
  }

  async function sugerirNomeRua(ll) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${ll[1]}&lon=${ll[0]}&zoom=18&addressdetails=1&accept-language=pt-BR`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const j = await r.json();
      const a = j.address || {};
      const rua = a.road || a.pedestrian || a.footway || a.neighbourhood || '';
      return rua ? { rua: rua.replace(/^Avenida /, 'Av. '), bairro: a.suburb || a.neighbourhood || a.quarter || '' } : null;
    } catch (_e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ inspetor
  const CATEGORIAS = ['Linha de Bairro', 'Linha Estrutural', 'Linha Regional', 'Linha Direta', 'Linha Corujão (Noturna)', 'Linha Atual (mantida)', 'Convencional'];
  const TIPOS_LINHA = { alimentadora: 'Alimentadora', expressa: 'Expressa / direta', convencional: 'Convencional', noturna: 'Noturna (Corujão)', atual: 'Linha atual mantida' };
  const SITUACOES = { disponivel: 'Traçado disponível', parcial: 'Traçado parcial', alterada: 'Traçado em atualização', indefinida: 'Traçado indefinido', indisponivel: 'Sem traçado' };
  const PALETA = ['#162652', '#0057B8', '#1a73e8', '#0891b2', '#0f766e', '#16a34a', '#65a30d', '#ca8a04', '#ea580c', '#D9531E', '#dc2626', '#E1515B', '#db2777', '#9333ea', '#6d28d9', '#475569'];
  const DIAS = { dias_uteis_sabados: 'Dias úteis e sábados', domingos_feriados: 'Domingos e feriados' };

  function renderInspetor() {
    const alvo = $('#ed-inspetor');
    if (S.sel?.tipo === 'linha') return inspetorLinha(alvo);
    if (S.sel?.tipo === 'parada') return inspetorParada(alvo);
    const feats = featuresDoDia();
    alvo.innerHTML = `
      <div class="ed-insp-vazio"><i class="bi bi-cursor"></i>Selecione uma linha ou parada no mapa ou na lista para ver e editar as propriedades.</div>
      <div class="ed-bloco"><h3><i class="bi bi-calendar3"></i>${esc(DIAS[S.dia])}</h3>
        <dl class="lista-chave-valor">
          <dt>Linhas cadastradas</dt><dd>${fmtNum(linhas().length)}</dd>
          <dt>Com traçado neste dia</dt><dd>${fmtNum(new Set(feats.map(numeroDe)).size)}</dd>
          <dt>Paradas (ativas)</dt><dd>${fmtNum(paradas().length)} (${fmtNum(paradas().filter(f => f.properties?.ativo !== false).length)})</dd>
          <dt>Problemas encontrados</dt><dd>${fmtNum(S.problemas.length)}</dd>
        </dl>
      </div>
      <div class="ed-bloco"><h3><i class="bi bi-lightbulb"></i>Como começar</h3>
        <p>1. Escolha uma linha na lista à esquerda.</p>
        <p>2. Use <strong>Pontos</strong> para ajustar o traçado ou <strong>Pelas ruas</strong> para refazer com pontos-guia.</p>
        <p>3. Clique em <strong>Salvar traçado</strong> e, quando terminar tudo, em <strong>Publicar</strong>.</p>
        <p>Atalhos: tecle <kbd>?</kbd>.</p>
      </div>`;
  }

  function cabecalhoLinha(l, numero) {
    const cor = corDe(l);
    return `<div class="ed-insp-cabecalho">
      <span class="ed-num-linha" style="background:${cor};color:${corClara(cor) ? '#14213d' : '#fff'}">${esc(numero)}</span>
      <h2>${esc(l?.nome || 'Linha sem cadastro')}<small>Lote ${esc(l?.lote || '?')} • ${esc(l?.categoria_edital || '')}</small></h2>
    </div>
    <div class="ed-subabas" role="tablist">
      ${[['tracado', 'Traçado'], ['dados', 'Dados'], ['paradas', 'Paradas'], ['operacao', 'Operação']]
        .map(([k, n]) => `<button type="button" role="tab" data-subaba="${k}" aria-selected="${S.subaba === k}">${n}</button>`)
        .join('')}
    </div>`;
  }

  function inspetorLinha(alvo) {
    const numero = S.sel.numero;
    const l = linhaDe(numero);
    let corpo = '';
    if (S.subaba === 'tracado') corpo = corpoTracado(l, numero);
    else if (S.subaba === 'dados') corpo = corpoDadosLinha(l, numero);
    else if (S.subaba === 'paradas') corpo = corpoParadasLinha(l, numero);
    else corpo = corpoOperacao(l, numero);
    alvo.innerHTML = cabecalhoLinha(l, numero) + corpo;
    alvo.querySelectorAll('[data-subaba]').forEach(b =>
      b.addEventListener('click', () => {
        S.subaba = b.dataset.subaba;
        renderInspetor();
      })
    );
    if (S.subaba === 'tracado') ligarTracado(l, numero);
    else if (S.subaba === 'dados') ligarDadosLinha(l, numero);
    else if (S.subaba === 'paradas') ligarParadasLinha();
    else ligarOperacao(l, numero);
  }

  function corpoTracado(l, numero) {
    const cor = corDe(l);
    const ida = coordsAtuais('ida');
    const volta = coordsAtuais('volta');
    const temFeature = Boolean(featureDe(numero));
    const outroDia = S.dia === 'dias_uteis_sabados' ? 'domingos_feriados' : 'dias_uteis_sabados';
    return `
      ${!temFeature && !ida.length ? `<div class="dica"><i class="bi bi-info-circle-fill"></i><span>Esta linha ainda não tem traçado em <strong>${esc(DIAS[S.dia])}</strong>. Use <strong>Pelas ruas</strong> ou <strong>Desenhar</strong> para criar.</span></div>` : ''}
      <div class="ed-bloco"><h3><i class="bi bi-signpost-2"></i>Sentido que você está editando</h3>
        <div class="ed-sentido">
          <button type="button" data-alvo="ida" aria-pressed="${ed?.alvo !== 'volta'}"><strong><span class="ed-amostra" style="background:${cor}"></span>Ida <kbd>1</kbd></strong><span>${fmtNum(ida.length)} pontos • ${fmtKm(comprimento(ida))}</span></button>
          <button type="button" data-alvo="volta" aria-pressed="${ed?.alvo === 'volta'}"><strong><span class="ed-amostra" style="background:${misturarCor(cor, 0.5)}"></span>Volta <kbd>2</kbd></strong><span>${fmtNum(volta.length)} pontos • ${fmtKm(comprimento(volta))}</span></button>
        </div>
        <p>Total ida + volta: <strong>${fmtKm(comprimento(ida) + comprimento(volta))}</strong>${ed?.guia?.[ed.alvo]?.length ? ` • ${ed.guia[ed.alvo].length} pontos-guia` : ''}</p>
      </div>
      <div class="ed-bloco"><h3><i class="bi bi-tools"></i>Ferramentas</h3>
        <div class="ed-acoes-grade">
          <button type="button" class="btn" data-ferr="vertices"><i class="bi bi-bezier2"></i> Ajustar pontos</button>
          <button type="button" class="btn" data-ferr="rotear"><i class="bi bi-signpost-split"></i> Refazer pelas ruas</button>
          <button type="button" class="btn" data-ferr="desenhar"><i class="bi bi-pencil"></i> Desenhar à mão</button>
          <button type="button" class="btn" data-acao="enquadrar"><i class="bi bi-arrows-fullscreen"></i> Enquadrar <kbd>F</kbd></button>
        </div>
      </div>
      <div class="ed-bloco"><h3><i class="bi bi-magic"></i>Ajustes no sentido ${ed?.alvo === 'volta' ? 'VOLTA' : 'IDA'}</h3>
        <label for="tr-simplificar">Simplificar (remove pontos quase em linha reta): <strong id="tr-simp-valor">5 m</strong></label>
        <input id="tr-simplificar" type="range" min="1" max="40" value="5">
        <p id="tr-simp-previa"></p>
        <div class="ed-acoes-grade">
          <button type="button" class="btn" data-acao="simplificar"><i class="bi bi-funnel"></i> Simplificar</button>
          <button type="button" class="btn" data-acao="inverter"><i class="bi bi-arrow-left-right"></i> Inverter sentido</button>
          <button type="button" class="btn" data-acao="volta-da-ida"><i class="bi bi-arrow-return-left"></i> Volta = ida invertida</button>
          <button type="button" class="btn" data-acao="trocar"><i class="bi bi-shuffle"></i> Trocar ida ↔ volta</button>
          <button type="button" class="btn" data-acao="limpar-guias"><i class="bi bi-x-circle"></i> Limpar pontos-guia</button>
          <button type="button" class="btn btn--perigo" data-acao="apagar-sentido"><i class="bi bi-eraser"></i> Apagar este sentido</button>
        </div>
      </div>
      <div class="ed-bloco"><h3><i class="bi bi-arrow-down-up"></i>Arquivos e outros dias</h3>
        <div class="ed-acoes-grade">
          <button type="button" class="btn" data-acao="importar-moovit"><i class="bi bi-box-arrow-in-down"></i> Importar do Moovit</button>
          <button type="button" class="btn" data-acao="importar"><i class="bi bi-upload"></i> Importar KML/GeoJSON</button>
          <button type="button" class="btn" data-acao="exportar-geojson"><i class="bi bi-filetype-json"></i> Baixar GeoJSON</button>
          <button type="button" class="btn" data-acao="exportar-kml"><i class="bi bi-globe-americas"></i> Baixar KML</button>
          <button type="button" class="btn" data-acao="copiar-dia"><i class="bi bi-copy"></i> Copiar p/ ${outroDia === 'domingos_feriados' ? 'Dom/Feriado' : 'Úteis/Sáb'}</button>
          <button type="button" class="btn btn--perigo" data-acao="remover-dia"><i class="bi bi-trash"></i> Remover traçado do dia</button>
        </div>
      </div>
      <div class="ed-salvar-tracado">
        ${ed?.sujo ? '<span class="ed-sujo"><i class="bi bi-circle-fill"></i> Não salvo</span>' : ''}
        <button type="button" class="btn btn--primario" data-acao="salvar-tracado" ${ed?.sujo ? '' : 'disabled'}><i class="bi bi-check2"></i> Salvar traçado <kbd>Ctrl+S</kbd></button>
        <button type="button" class="btn" data-acao="descartar-tracado" ${ed?.sujo ? '' : 'disabled'}>Descartar</button>
      </div>`;
  }

  function ligarTracado(l, numero) {
    const raiz = $('#ed-inspetor');
    raiz.querySelectorAll('[data-alvo]').forEach(b => b.addEventListener('click', () => definirAlvo(b.dataset.alvo)));
    raiz.querySelectorAll('[data-ferr]').forEach(b => b.addEventListener('click', () => definirFerramenta(b.dataset.ferr)));
    const slider = $('#tr-simplificar');
    const previaSimp = () => {
      const m = Number(slider.value);
      $('#tr-simp-valor').textContent = `${m} m`;
      const atual = ed?.[ed.alvo] || [];
      const depois = U.simplificarLineString(atual, m / 111320);
      $('#tr-simp-previa').textContent = atual.length > 2 ? `${fmtNum(atual.length)} → ${fmtNum(depois.length)} pontos` : '';
    };
    slider.addEventListener('input', previaSimp);
    previaSimp();
    raiz.querySelectorAll('[data-acao]').forEach(b => b.addEventListener('click', () => acaoTracado(b.dataset.acao, numero)));
  }

  async function acaoTracado(acao, numero) {
    if (!ed) abrirSessao(numero);
    const s = ed.alvo;
    const outro = s === 'ida' ? 'volta' : 'ida';
    switch (acao) {
      case 'enquadrar':
        enquadrarSelecao();
        return;
      case 'simplificar': {
        const m = Number($('#tr-simplificar').value);
        registrarPasso();
        ed[s] = U.simplificarLineString(ed[s], m / 111320).map(c => [arred(c[0]), arred(c[1])]);
        geometriaAlterada();
        return;
      }
      case 'inverter':
        registrarPasso();
        ed[s] = ed[s].slice().reverse();
        ed.guia[s] = ed.guia[s].slice().reverse();
        geometriaAlterada();
        return;
      case 'volta-da-ida':
        if (ed.volta.length && !confirm('Substituir a volta atual pela ida invertida?')) return;
        registrarPasso();
        ed.volta = ed.ida.slice().reverse();
        ed.guia.volta = ed.guia.ida.slice().reverse();
        geometriaAlterada();
        return;
      case 'trocar':
        registrarPasso();
        [ed.ida, ed.volta] = [ed.volta, ed.ida];
        [ed.guia.ida, ed.guia.volta] = [ed.guia.volta, ed.guia.ida];
        geometriaAlterada();
        return;
      case 'limpar-guias':
        registrarPasso();
        ed.guia[s] = [];
        geometriaAlterada();
        return;
      case 'apagar-sentido':
        if (!confirm(`Apagar todos os pontos da ${s === 'ida' ? 'IDA' : 'VOLTA'}? (dá para desfazer)`)) return;
        registrarPasso();
        ed[s] = [];
        ed.guia[s] = [];
        geometriaAlterada();
        return;
      case 'importar':
        $('#ed-arquivo').click();
        return;
      case 'importar-moovit':
        abrirDialogoMoovit();
        return;
      case 'exportar-geojson':
        exportarGeoJson(numero);
        return;
      case 'exportar-kml':
        exportarKml(numero);
        return;
      case 'copiar-dia':
        await copiarParaOutroDia(numero);
        return;
      case 'remover-dia':
        if (!confirm(`Remover o traçado da linha ${numero} em ${DIAS[S.dia]}? As paradas deixam de ser ligadas a ela neste dia. (Fica no rascunho; dá para desfazer.)`)) return;
        ocupado(true, 'Removendo traçado…');
        try {
          await D.removerTracadoLinhaNoMapa(numero, S.dia);
          abrirSessao(numero);
          toast('Traçado removido deste dia (no rascunho).');
          depoisDeAlterarDados();
        } finally {
          ocupado(false);
        }
        return;
      case 'salvar-tracado':
        await salvarTracado();
        return;
      case 'descartar-tracado':
        if (!confirm('Descartar as alterações do traçado que ainda não foram salvas?')) return;
        abrirSessao(numero);
        renderTudo();
        return;
      default:
        void outro;
    }
  }

  async function copiarParaOutroDia(numero) {
    if (ed?.sujo) {
      toast('Salve o traçado antes de copiar para o outro dia.', true);
      return;
    }
    const destino = S.dia === 'dias_uteis_sabados' ? 'domingos_feriados' : 'dias_uteis_sabados';
    if (featureDe(numero, destino) && featureDe(numero, destino) !== featureDe(numero, S.dia)) {
      if (!confirm(`A linha ${numero} já tem traçado em ${DIAS[destino]}. Substituir pelo traçado de ${DIAS[S.dia]}?`)) return;
    }
    const { ida, volta } = ed;
    const coords = volta.length > 1 ? [...ida, ...volta] : ida;
    if (coords.length < 2) {
      toast('Não há traçado para copiar.', true);
      return;
    }
    ocupado(true, 'Copiando traçado…');
    try {
      const atual = featureDe(numero, S.dia);
      if (atual && !atual.properties.dia_semana) atual.properties.dia_semana = S.dia;
      await D.atualizarRotaNoMapa(numero, destino, coords, { ...metaDaLinha(numero), ...(volta.length > 1 ? { indice_retorno: ida.length - 1 } : {}) });
      const f = featureDe(numero, destino);
      if (f) {
        f.properties.coordenadas_ida = clone(ida);
        f.properties.coordenadas_volta = volta.length > 1 ? clone(volta) : [];
        f.properties.pontos_guia_ida = clone(ed.guia.ida);
        f.properties.pontos_guia_volta = clone(ed.guia.volta);
        await D.salvarOverrideAdmin({ publicar: false });
      }
      toast(`Traçado copiado para ${DIAS[destino]} (no rascunho).`);
      depoisDeAlterarDados();
    } finally {
      ocupado(false);
    }
  }

  function corpoDadosLinha(l, numero) {
    if (!l) return '<p class="vazio">Esta linha não está no cadastro (linhas.json).</p>';
    const cor = corDe(l);
    const dias = l.dias_disponiveis || [];
    return `
      <form id="form-linha" novalidate>
        <label for="li-nome">Nome</label><input id="li-nome" maxlength="140" value="${esc(l.nome)}">
        <label>Cor</label>
        <div class="ed-cor-linha"><input id="li-cor" type="color" value="${esc(cor)}"><input id="li-cor-hex" maxlength="7" value="${esc(cor)}" aria-label="Cor em hexadecimal"></div>
        <div class="ed-paleta">${PALETA.map(c => `<button type="button" data-cor="${c}" title="${c}" style="background:${c}"></button>`).join('')}</div>
        <div class="ed-duas-colunas">
          <div><label for="li-lote">Lote</label><select id="li-lote"><option value="1"${String(l.lote) === '1' ? ' selected' : ''}>1 (Norte)</option><option value="2"${String(l.lote) === '2' ? ' selected' : ''}>2 (Sul)</option></select></div>
          <div><label for="li-tipo">Tipo</label><select id="li-tipo">${Object.entries(TIPOS_LINHA).map(([k, n]) => `<option value="${k}"${l.tipo === k ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        </div>
        <label for="li-categoria">Categoria do edital</label>
        <select id="li-categoria">${[...new Set([...CATEGORIAS, l.categoria_edital].filter(Boolean))].map(c => `<option${l.categoria_edital === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <label for="li-situacao">Situação do traçado</label>
        <select id="li-situacao">${Object.entries(SITUACOES).map(([k, n]) => `<option value="${k}"${(l.situacao_rota || 'disponivel') === k ? ' selected' : ''}>${n}</option>`).join('')}</select>
        <label for="li-empresa">Empresa operadora</label><input id="li-empresa" maxlength="80" value="${esc(l.empresa || '')}" placeholder="Não informada">
        <label for="li-tarifa">Tarifa</label><input id="li-tarifa" maxlength="120" value="${esc(l.tarifa || '')}">
        <label>Dias de operação</label>
        <div class="ed-checks">
          ${Object.entries(DIAS).map(([k, n]) => `<label><input type="checkbox" data-dia-op="${k}"${dias.includes(k) ? ' checked' : ''}> ${n}</label>`).join('')}
          <label><input type="checkbox" id="li-acessivel"${l.acessivel !== false ? ' checked' : ''}> Acessível</label>
        </div>
        <div class="acoes-form">
          <button type="submit" class="btn btn--primario"><i class="bi bi-check2"></i> Salvar dados</button>
        </div>
      </form>
      <div class="ed-bloco"><h3><i class="bi bi-exclamation-octagon"></i>Zona de perigo</h3>
        <p>Excluir remove a linha do cadastro, os traçados de todos os dias e os vínculos com as paradas (fica no rascunho até publicar).</p>
        <button type="button" id="li-excluir" class="btn btn--perigo btn--peq"><i class="bi bi-trash"></i> Excluir linha ${esc(numero)}</button>
      </div>`;
  }

  function ligarDadosLinha(l, numero) {
    if (!l) return;
    const cor = $('#li-cor');
    const hex = $('#li-cor-hex');
    cor.addEventListener('input', () => (hex.value = cor.value));
    hex.addEventListener('input', () => {
      if (/^#[0-9a-f]{6}$/i.test(hex.value)) cor.value = hex.value;
    });
    $$('#ed-inspetor [data-cor]').forEach(b =>
      b.addEventListener('click', () => {
        cor.value = b.dataset.cor;
        hex.value = b.dataset.cor;
      })
    );
    $('#form-linha').addEventListener('submit', async e => {
      e.preventDefault();
      const nome = $('#li-nome').value.trim();
      if (!nome) {
        toast('O nome da linha não pode ficar vazio.', true);
        return;
      }
      const novaCor = /^#[0-9a-f]{6}$/i.test(hex.value) ? hex.value.toUpperCase() : cor.value.toUpperCase();
      const dias = $$('#ed-inspetor [data-dia-op]').filter(c => c.checked).map(c => c.dataset.diaOp);
      D.registrarSnapshotUndoAdmin(`Dados da linha ${numero}`);
      const loteNovo = $('#li-lote').value;
      const loteAntigo = String(l.lote || '1');
      Object.assign(l, {
        nome,
        cor: novaCor,
        lote: loteNovo,
        tipo: $('#li-tipo').value,
        categoria_edital: $('#li-categoria').value,
        situacao_rota: $('#li-situacao').value,
        empresa: $('#li-empresa').value.trim() || null,
        tarifa: $('#li-tarifa').value.trim(),
        acessivel: $('#li-acessivel').checked,
        dias_disponiveis: dias
      });
      for (const v of Object.values(l.variantes_dia || {})) {
        v.cor = novaCor;
        v.nome = nome;
      }
      const cache = E().cacheGeoJsonLotes;
      for (const f of todasFeatures().filter(x => numeroDe(x) === numero)) {
        Object.assign(f.properties, { nome, cor: novaCor, lote: loteNovo, tipo: l.tipo, categoria_edital: l.categoria_edital });
        if (loteNovo !== loteAntigo) {
          for (const id of Object.keys(cache)) {
            if (cache[id]?.features) cache[id].features = cache[id].features.filter(x => x !== f);
          }
          if (!cache[loteNovo]) cache[loteNovo] = { type: 'FeatureCollection', features: [] };
          cache[loteNovo].features.push(f);
        }
      }
      E().grafoMemoria = {};
      await D.salvarOverrideAdmin({ publicar: false, resumoAcao: `Dados da linha ${numero} editados` });
      toast('Dados da linha salvos no rascunho.');
      depoisDeAlterarDados();
    });
    $('#li-excluir').addEventListener('click', async () => {
      const resp = prompt(`Para excluir a linha ${numero}, digite o código dela (${numero}):`);
      if (String(resp || '').trim().toUpperCase() !== numero) return;
      await excluirLinha(numero);
    });
  }

  async function excluirLinha(numero) {
    D.registrarSnapshotUndoAdmin(`Excluir linha ${numero}`);
    const est = E();
    est.indice.linhas = est.indice.linhas.filter(l => String(l.numero).toUpperCase() !== numero);
    for (const id of Object.keys(est.cacheGeoJsonLotes || {})) {
      const fc = est.cacheGeoJsonLotes[id];
      if (fc?.features) fc.features = fc.features.filter(f => numeroDe(f) !== numero);
    }
    est.linhaParadas = (est.linhaParadas || []).filter(lp => String(lp.linha_id).toUpperCase() !== numero);
    for (const f of paradas()) {
      const p = f.properties || {};
      if (Array.isArray(p.rotas)) p.rotas = p.rotas.filter(r => String(r).toUpperCase() !== numero);
      if (Array.isArray(p.rotas_dia)) p.rotas_dia = p.rotas_dia.filter(r => String(r).toUpperCase() !== numero);
    }
    est.grafoMemoria = {};
    await D.salvarOverrideAdmin({ publicar: false, resumoAcao: `Linha ${numero} excluída` });
    ed = null;
    S.sel = null;
    toast(`Linha ${numero} excluída (no rascunho).`);
    depoisDeAlterarDados();
  }

  function corpoParadasLinha(l, numero) {
    const v = vinculosLinha(numero);
    const lista = sentido => {
      const itens = v.filter(x => x.sentido === sentido).sort((a, b) => a.ordem_sequencial - b.ordem_sequencial);
      if (!itens.length) return '<p>Nenhuma parada ligada neste sentido.</p>';
      return `<ol class="ed-lista-paradas-linha">${itens
        .map(x => {
          const f = paradaDe(x.parada_id);
          return `<li data-parada="${esc(x.parada_id)}"><span class="ord">${x.ordem_sequencial}</span><span>${esc(f?.properties?.nome || x.parada_id)}</span><span class="dist">${fmtM(x.distancia_acumulada_metros || 0)}</span></li>`;
        })
        .join('')}</ol>`;
    };
    return `
      <div class="dica"><i class="bi bi-info-circle-fill"></i><span>As paradas são ligadas automaticamente quando ficam a até 40 m do traçado, no sentido certo. Mova a parada ou ajuste o traçado e salve para recalcular.</span></div>
      <div class="ed-bloco"><h3>Ida (${fmtNum(v.filter(x => x.sentido === 'IDA').length)})</h3>${lista('IDA')}</div>
      <div class="ed-bloco"><h3>Volta (${fmtNum(v.filter(x => x.sentido === 'VOLTA').length)})</h3>${lista('VOLTA')}</div>
      <div class="acoes-form"><button type="button" id="li-recalcular" class="btn"><i class="bi bi-arrow-repeat"></i> Recalcular paradas desta linha</button></div>`;
  }

  function ligarParadasLinha() {
    $$('#ed-inspetor [data-parada]').forEach(li =>
      li.addEventListener('click', () => {
        const f = paradaDe(li.dataset.parada);
        if (f) mapa.setView([f.geometry.coordinates[1], f.geometry.coordinates[0]], Math.max(mapa.getZoom(), 17));
      })
    );
    $('#li-recalcular')?.addEventListener('click', async () => {
      if (ed?.sujo) {
        toast('Salve o traçado primeiro: o recálculo usa o traçado salvo.', true);
        return;
      }
      ed.sujo = true;
      await salvarTracado();
    });
  }

  const CAMPOS_OPERACAO = [
    ['veiculo', 'Veículo', 'text'],
    ['extensao_ida_volta_km', 'Extensão ida+volta (km)', 'number'],
    ['tempo_ciclo_min', 'Tempo de ciclo (min)', 'number'],
    ['intervalo_du', 'Intervalo dias úteis (min)', 'number'],
    ['intervalo_sab', 'Intervalo sábado (min)', 'number'],
    ['intervalo_dom', 'Intervalo domingo (min)', 'number'],
    ['frota_du', 'Frota dias úteis', 'number'],
    ['frota_sab', 'Frota sábado', 'number'],
    ['frota_dom', 'Frota domingo', 'number'],
    ['viagens_mes', 'Viagens por mês', 'number']
  ];

  function corpoOperacao(l) {
    if (!l) return '<p class="vazio">Linha sem cadastro.</p>';
    const op = l.operacao || {};
    return `
      <form id="form-operacao" novalidate>
        <label for="op-freq-pico">Frequência no pico (texto exibido no site)</label><input id="op-freq-pico" maxlength="120" value="${esc(l.frequencia_pico || '')}">
        <label for="op-freq-entre">Frequência fora do pico</label><input id="op-freq-entre" maxlength="160" value="${esc(l.frequencia_entre_pico || '')}">
        <div class="ed-duas-colunas">
          ${CAMPOS_OPERACAO.map(([k, n, t]) => `<div><label for="op-${k}">${n}</label><input id="op-${k}" data-op="${k}" type="${t}" ${t === 'number' ? 'step="any" min="0"' : 'maxlength="60"'} value="${esc(op[k] ?? '')}"></div>`).join('')}
        </div>
        <label for="op-fonte">Fonte</label><input id="op-fonte" data-op="fonte" maxlength="120" value="${esc(op.fonte || '')}">
        <div class="acoes-form"><button type="submit" class="btn btn--primario"><i class="bi bi-check2"></i> Salvar operação</button></div>
      </form>`;
  }

  function ligarOperacao(l, numero) {
    if (!l) return;
    $('#form-operacao').addEventListener('submit', async e => {
      e.preventDefault();
      D.registrarSnapshotUndoAdmin(`Operação da linha ${numero}`);
      l.frequencia_pico = $('#op-freq-pico').value.trim();
      l.frequencia_entre_pico = $('#op-freq-entre').value.trim();
      l.operacao = l.operacao || {};
      $$('#ed-inspetor [data-op]').forEach(inp => {
        const v = inp.value.trim();
        if (v === '') delete l.operacao[inp.dataset.op];
        else l.operacao[inp.dataset.op] = inp.type === 'number' ? Number(v) : v;
      });
      await D.salvarOverrideAdmin({ publicar: false, resumoAcao: `Operação da linha ${numero} editada` });
      toast('Dados de operação salvos no rascunho.');
      depoisDeAlterarDados();
    });
  }

  // ---------- inspetor de parada ----------
  function inspetorParada(alvo) {
    const f = paradaDe(S.sel.id);
    if (!f) {
      alvo.innerHTML = '<p class="vazio">Parada não encontrada.</p>';
      return;
    }
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const v = vinculosParada(p.id);
    const porLinha = new Map();
    for (const x of v) {
      const k = String(x.linha_id).toUpperCase();
      if (!porLinha.has(k)) porLinha.set(k, []);
      porLinha.get(k).push(x);
    }
    const tipoAtual = String(p.tipo || 'parada');
    alvo.innerHTML = `
      <div class="ed-insp-cabecalho"><span class="ed-icone-tipo"><i class="bi bi-geo-alt-fill"></i></span><h2>${esc(p.nome)}<small>${esc(p.id)}${p.ativo === false ? ' • INATIVA' : ''}</small></h2></div>
      <form id="form-parada" novalidate>
        <label for="pa-nome">Nome</label>
        <div class="campo-senha"><input id="pa-nome" maxlength="120" value="${esc(p.nome)}"><button type="button" id="pa-sugerir" class="btn-icone" title="Sugerir nome pela rua (OpenStreetMap)" aria-label="Sugerir nome pela rua"><i class="bi bi-magic"></i></button></div>
        <div class="ed-duas-colunas">
          <div><label for="pa-tipo">Tipo</label><select id="pa-tipo">${['parada', 'terminal', 'ponto de integração'].map(t => `<option value="${t}"${tipoAtual === t ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></div>
          <div><label for="pa-sentidos">Sentidos atendidos</label><select id="pa-sentidos">${[['AUTO', 'Detectar sozinho'], ['AMBOS', 'Ida e volta'], ['IDA', 'Só ida'], ['VOLTA', 'Só volta']].map(([k, n]) => `<option value="${k}"${String(p.sentidos_atendidos || 'AMBOS').toUpperCase() === k ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        </div>
        <label for="pa-bairro">Bairro</label><input id="pa-bairro" maxlength="80" value="${esc(p.bairro || '')}">
        <div class="ed-checks">
          <label><input type="checkbox" id="pa-ativo"${p.ativo !== false ? ' checked' : ''}> Parada ativa</label>
          <label><input type="checkbox" id="pa-acessivel"${p.acessivel !== 'nao' && p.acessivel !== false ? ' checked' : ''}> Acessível</label>
        </div>
        <div class="ed-duas-colunas">
          <div><label for="pa-lat">Latitude</label><input id="pa-lat" type="number" step="0.000001" value="${lat}"></div>
          <div><label for="pa-lng">Longitude</label><input id="pa-lng" type="number" step="0.000001" value="${lng}"></div>
        </div>
        <p class="ed-lista-info">Dica: arraste o marcador vermelho no mapa para mover a parada.</p>
        <div class="acoes-form"><button type="submit" class="btn btn--primario"><i class="bi bi-check2"></i> Salvar parada</button>
          <button type="button" id="pa-centralizar" class="btn"><i class="bi bi-crosshair"></i> Centralizar</button></div>
      </form>
      <div class="ed-bloco"><h3><i class="bi bi-bus-front"></i>Linhas que param aqui (${fmtNum(porLinha.size)})</h3>
        ${
          porLinha.size
            ? `<div class="ed-chips">${[...porLinha.entries()]
                .sort()
                .map(([num, xs]) => {
                  const cor = corDe(linhaDe(num));
                  const desc = xs.map(x => `${x.sentido === 'VOLTA' ? 'volta' : 'ida'} #${x.ordem_sequencial} (${x.dia_semana === 'domingos_feriados' ? 'dom' : 'úteis'})`).join(', ');
                  return `<button type="button" class="ed-chip" data-linha="${esc(num)}" title="${esc(desc)}" style="background:${cor};color:${corClara(cor) ? '#14213d' : '#fff'}">${esc(num)}</button>`;
                })
                .join('')}</div>`
            : '<p>Nenhuma linha passa a até 40 m desta parada.</p>'
        }
      </div>
      <div class="ed-bloco"><h3><i class="bi bi-exclamation-octagon"></i>Excluir</h3>
        <p>Prefira desmarcar "Parada ativa" se ela só estiver fora de uso.</p>
        <button type="button" id="pa-excluir" class="btn btn--perigo btn--peq"><i class="bi bi-trash"></i> Excluir parada</button>
      </div>`;

    $('#pa-sugerir').addEventListener('click', async () => {
      const s = await sugerirNomeRua([Number($('#pa-lng').value), Number($('#pa-lat').value)]);
      if (!s) {
        toast('Não encontrei o nome da rua aqui.', true);
        return;
      }
      $('#pa-nome').value = s.rua;
      if (s.bairro) $('#pa-bairro').value = s.bairro;
    });
    $('#pa-centralizar').addEventListener('click', enquadrarSelecao);
    $$('#ed-inspetor [data-linha]').forEach(b => b.addEventListener('click', () => selecionarLinha(b.dataset.linha)));
    $('#form-parada').addEventListener('submit', async e => {
      e.preventDefault();
      const nome = $('#pa-nome').value.trim();
      const nLat = Number($('#pa-lat').value);
      const nLng = Number($('#pa-lng').value);
      if (!nome || !Number.isFinite(nLat) || !Number.isFinite(nLng)) {
        toast('Preencha o nome e coordenadas válidas.', true);
        return;
      }
      ocupado(true, 'Salvando parada…');
      try {
        await D.criarOuEditarParadaNoMapa({
          id: p.id,
          nome,
          tipo: $('#pa-tipo').value,
          ativo: $('#pa-ativo').checked,
          sentidos_atendidos: $('#pa-sentidos').value,
          lat: nLat,
          lng: nLng,
          origem: p.origem || 'manual'
        });
        p.bairro = $('#pa-bairro').value.trim();
        p.acessivel = $('#pa-acessivel').checked ? 'sim' : 'nao';
        await D.salvarOverrideAdmin({ publicar: false, resumoAcao: `Parada ${p.id} (${nome}) editada` });
        toast('Parada salva no rascunho.');
        depoisDeAlterarDados();
      } catch (err) {
        toast(`Erro ao salvar a parada: ${err.message}`, true);
      } finally {
        ocupado(false);
      }
    });
    $('#pa-excluir').addEventListener('click', async () => {
      if (!confirm(`Excluir a parada "${p.nome}"? Ela sai de todas as linhas. (Fica no rascunho; dá para desfazer.)`)) return;
      await D.excluirParadaNoMapa(p.id);
      S.sel = null;
      toast('Parada excluída (no rascunho).');
      depoisDeAlterarDados();
    });
  }

  // ------------------------------------------------------------------ listas (esquerda)
  function renderListaLinhas() {
    const termo = U.normalizarTexto($('#ed-filtro-linhas').value);
    const lote = $('#ed-filtro-lote').value;
    const sit = $('#ed-filtro-situacao').value;
    const comTracado = new Set(featuresDoDia().map(numeroDe));
    const itens = linhas()
      .filter(l => {
        const num = String(l.numero).toUpperCase();
        if (lote && String(l.lote) !== lote) return false;
        if (sit === 'com' && !comTracado.has(num)) return false;
        if (sit === 'sem' && comTracado.has(num)) return false;
        return !termo || U.normalizarTexto(`${l.numero} ${l.nome}`).includes(termo);
      })
      .sort((a, b) => String(a.numero).localeCompare(String(b.numero), 'pt-BR', { numeric: true }));
    $('#ed-lista-linhas').innerHTML = itens
      .map(l => {
        const num = String(l.numero).toUpperCase();
        const cor = corDe(l);
        const f = featureDe(num);
        const km = f ? comprimento(f.geometry.coordinates.filter(coordValida)) : 0;
        const atual = S.sel?.tipo === 'linha' && S.sel.numero === num;
        return `<li data-linha="${esc(num)}" aria-current="${atual}"><span class="ed-num-linha" style="background:${cor};color:${corClara(cor) ? '#14213d' : '#fff'}">${esc(num)}</span>
          <span class="ed-item-corpo"><span class="ed-item-titulo">${esc(l.nome)}</span><span class="ed-item-sub">${f ? `${fmtKm(km)} • Lote ${esc(l.lote)}` : '<i class="bi bi-exclamation-circle"></i> sem traçado neste dia'}</span></span></li>`;
      })
      .join('');
    $$('#ed-lista-linhas [data-linha]').forEach(li => li.addEventListener('click', () => selecionarLinha(li.dataset.linha)));
  }

  function renderListaParadas() {
    const termo = U.normalizarTexto($('#ed-filtro-paradas').value);
    const tipo = $('#ed-filtro-tipo').value;
    const sit = $('#ed-filtro-ativa').value;
    const comLinha = sit === 'semlinha' ? new Set((E().linhaParadas || []).map(v => String(v.parada_id))) : null;
    const todas = paradas().filter(f => {
      const p = f.properties || {};
      if (tipo && String(p.tipo) !== tipo) return false;
      if (sit === 'ativa' && p.ativo === false) return false;
      if (sit === 'inativa' && p.ativo !== false) return false;
      if (comLinha && (comLinha.has(String(p.id)) || p.ativo === false)) return false;
      return !termo || U.normalizarTexto(`${p.nome} ${p.id} ${p.bairro || ''}`).includes(termo);
    });
    const LIM = 300;
    $('#ed-qtd-paradas').textContent = todas.length > LIM ? `Mostrando ${LIM} de ${fmtNum(todas.length)} — refine a busca` : `${fmtNum(todas.length)} parada(s)`;
    $('#ed-lista-paradas').innerHTML = todas
      .slice(0, LIM)
      .map(f => {
        const p = f.properties;
        const t = tipoParada(p);
        const atual = S.sel?.tipo === 'parada' && String(S.sel.id) === String(p.id);
        return `<li data-parada="${esc(p.id)}" aria-current="${atual}"><span class="ed-icone-tipo"><i class="bi ${t === 'terminal' ? 'bi-building' : t === 'integracao' ? 'bi-arrow-left-right' : 'bi-geo-alt'}"></i></span>
          <span class="ed-item-corpo"><span class="ed-item-titulo">${esc(p.nome)}</span><span class="ed-item-sub">${esc(p.bairro || '')} • ${esc(p.id)}${p.ativo === false ? ' • inativa' : ''}</span></span></li>`;
      })
      .join('');
    $$('#ed-lista-paradas [data-parada]').forEach(li => li.addEventListener('click', () => selecionarParada(li.dataset.parada, true)));
  }

  function renderListaAlteracoes() {
    const st = D.obterStatusRascunho();
    $('#ed-lista-alteracoes').innerHTML = st.acoes.length
      ? st.acoes
          .slice()
          .reverse()
          .map(a => `<li><i class="bi bi-dot"></i><span>${esc(a)}</span></li>`)
          .join('')
      : '<li><span>Nenhuma alteração pendente. Tudo o que está aqui já está publicado.</span></li>';
  }

  // ------------------------------------------------------------------ problemas (verificação automática)
  function diagnosticar() {
    const out = [];
    const feats = featuresDoDia();
    const comTracado = new Set(feats.map(numeroDe));
    for (const l of linhas()) {
      const num = String(l.numero).toUpperCase();
      const opera = !(l.dias_disponiveis || []).length || l.dias_disponiveis.includes(S.dia);
      if (opera && !comTracado.has(num)) out.push({ sev: 'alerta', texto: `Linha ${num} sem traçado neste dia`, alvo: { linha: num } });
    }
    for (const f of feats) {
      const num = numeroDe(f);
      const { ida, volta } = separarSentidos(f);
      for (const [nome, cs] of [['ida', ida], ['volta', volta]]) {
        let maior = 0;
        let onde = null;
        for (let i = 1; i < cs.length; i++) {
          const d = distM(cs[i - 1], cs[i]);
          if (d > maior) {
            maior = d;
            onde = [(cs[i - 1][0] + cs[i][0]) / 2, (cs[i - 1][1] + cs[i][1]) / 2];
          }
        }
        if (maior > 500) out.push({ sev: 'erro', texto: `${num}: salto de ${fmtM(maior)} na ${nome} (trecho sem pontos)`, alvo: { linha: num, ponto: onde } });
      }
      if (volta.length < 2) out.push({ sev: 'info', texto: `${num}: ida e volta não estão separadas`, alvo: { linha: num } });
      else if (ida.length && distM(ida[ida.length - 1], volta[0]) > 200) {
        out.push({ sev: 'alerta', texto: `${num}: fim da ida a ${fmtM(distM(ida[ida.length - 1], volta[0]))} do começo da volta`, alvo: { linha: num, ponto: ida[ida.length - 1] } });
      }
      const v = vinculosLinha(num);
      if (!v.some(x => x.sentido === 'IDA')) out.push({ sev: 'alerta', texto: `${num}: nenhuma parada ligada na ida`, alvo: { linha: num } });
      if (volta.length > 1 && !v.some(x => x.sentido === 'VOLTA')) out.push({ sev: 'alerta', texto: `${num}: nenhuma parada ligada na volta`, alvo: { linha: num } });
    }
    // paradas: duplicadas, sem linha e nomes genéricos
    const ligadas = new Set((E().linhaParadas || []).map(v => String(v.parada_id)));
    const grade = new Map();
    const chave = (x, y) => `${Math.floor(x / 0.0003)}|${Math.floor(y / 0.0003)}`;
    let semLinha = 0;
    for (const f of paradas()) {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (p.ativo === false || !coordValida(c)) continue;
      if (/^(parada revisada|parada manual|nova parada|via local|parada virtual)/i.test(String(p.nome || ''))) {
        out.push({ sev: 'info', texto: `Nome genérico: "${p.nome}"`, alvo: { parada: p.id } });
      }
      if (!ligadas.has(String(p.id))) {
        semLinha++;
        if (semLinha <= 150) out.push({ sev: 'info', texto: `Parada sem linha: ${p.nome}`, alvo: { parada: p.id } });
      }
      const [x, y] = c;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const k = `${Math.floor(x / 0.0003) + dx}|${Math.floor(y / 0.0003) + dy}`;
          for (const o of grade.get(k) || []) {
            if (distM(c, o.geometry.coordinates) < 8) {
              out.push({ sev: 'alerta', texto: `Paradas duplicadas: "${p.nome}" e "${o.properties.nome}"`, alvo: { parada: p.id } });
            }
          }
        }
      }
      const k0 = chave(x, y);
      if (!grade.has(k0)) grade.set(k0, []);
      grade.get(k0).push(f);
    }
    const ordem = { erro: 0, alerta: 1, info: 2 };
    S.problemas = out.sort((a, b) => ordem[a.sev] - ordem[b.sev]);
    renderProblemas();
    if (!S.sel) renderInspetor();
  }

  let timerDiag = null;
  function agendarDiagnostico() {
    clearTimeout(timerDiag);
    timerDiag = setTimeout(diagnosticar, 250);
  }

  function renderProblemas() {
    const filtro = $('#ed-filtro-problemas').value;
    const lista = S.problemas.filter(p => !filtro || p.sev === filtro);
    const graves = S.problemas.filter(p => p.sev !== 'info').length;
    $('#ed-qtd-problemas').textContent = graves ? String(graves) : '';
    const icone = { erro: 'bi-x-octagon-fill', alerta: 'bi-exclamation-triangle-fill', info: 'bi-info-circle-fill' };
    $('#ed-lista-problemas').innerHTML = lista.length
      ? lista
          .slice(0, 400)
          .map((p, i) => `<li data-prob="${i}"><span class="ed-icone-tipo ed-icone-tipo--${p.sev}"><i class="bi ${icone[p.sev]}"></i></span><span class="ed-item-corpo"><span class="ed-item-titulo" title="${esc(p.texto)}">${esc(p.texto)}</span></span></li>`)
          .join('')
      : '<li><span class="ed-item-corpo">Nenhum problema encontrado. 👍</span></li>';
    $$('#ed-lista-problemas [data-prob]').forEach(li =>
      li.addEventListener('click', () => {
        const p = lista[Number(li.dataset.prob)];
        if (p.alvo.linha) {
          selecionarLinha(p.alvo.linha, !p.alvo.ponto);
          if (p.alvo.ponto) mapa.setView([p.alvo.ponto[1], p.alvo.ponto[0]], 17);
        } else if (p.alvo.parada) {
          selecionarParada(p.alvo.parada, true);
        }
      })
    );
  }

  // ------------------------------------------------------------------ importar / exportar
  function linhasDeGeoJson(gj) {
    const out = [];
    const visitar = g => {
      if (!g) return;
      if (g.type === 'FeatureCollection') g.features.forEach(f => visitar(f.geometry));
      else if (g.type === 'Feature') visitar(g.geometry);
      else if (g.type === 'LineString') out.push(g.coordinates);
      else if (g.type === 'MultiLineString') g.coordinates.forEach(c => out.push(c));
      else if (g.type === 'GeometryCollection') g.geometries.forEach(visitar);
    };
    visitar(gj);
    return out.map(cs => cs.filter(coordValida).map(c => [arred(c[0]), arred(c[1])])).filter(cs => cs.length > 1);
  }

  function linhasDeKml(texto) {
    const xml = new DOMParser().parseFromString(texto, 'text/xml');
    return Array.from(xml.getElementsByTagName('LineString'))
      .map(ls => {
        const t = ls.getElementsByTagName('coordinates')[0]?.textContent || '';
        return t
          .trim()
          .split(/\s+/)
          .map(par => par.split(',').map(Number))
          .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]))
          .map(c => [arred(c[0]), arred(c[1])]);
      })
      .filter(cs => cs.length > 1);
  }

  async function kmlDeKmz(arquivo) {
    const buf = await arquivo.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    let o = 0;
    while (o + 30 < bytes.length) {
      if (view.getUint32(o, true) !== 0x04034b50) break;
      const metodo = view.getUint16(o + 8, true);
      const tam = view.getUint32(o + 18, true);
      const tamNome = view.getUint16(o + 26, true);
      const tamExtra = view.getUint16(o + 28, true);
      const nome = new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + tamNome));
      const ini = o + 30 + tamNome + tamExtra;
      const dados = bytes.subarray(ini, ini + tam);
      if (nome.toLowerCase().endsWith('.kml')) {
        if (metodo === 0) return new TextDecoder('utf-8').decode(dados);
        if (metodo === 8 && typeof DecompressionStream !== 'undefined') {
          const ds = new DecompressionStream('deflate-raw');
          const w = ds.writable.getWriter();
          w.write(dados);
          w.close();
          return new Response(ds.readable).text();
        }
      }
      o = ini + tam;
    }
    throw new Error('não encontrei o arquivo .kml dentro do KMZ');
  }

  async function importarArquivo(arquivo) {
    if (!ed) return;
    try {
      const nome = arquivo.name.toLowerCase();
      let trechos = [];
      if (nome.endsWith('.kmz')) trechos = linhasDeKml(await kmlDeKmz(arquivo));
      else if (nome.endsWith('.kml')) trechos = linhasDeKml(await arquivo.text());
      else {
        const json = JSON.parse(await arquivo.text());
        if (json?.formato === 'buzurota-moovit') {
          mostrarImportMoovit(json);
          return;
        }
        trechos = linhasDeGeoJson(json);
      }
      if (!trechos.length) throw new Error('nenhuma linha (LineString) encontrada');
      registrarPasso();
      if (trechos.length >= 2 && confirm(`O arquivo tem ${trechos.length} traçados. Usar o 1º como IDA e o 2º como VOLTA?\n\n(Cancelar = usar só o 1º no sentido que você está editando)`)) {
        ed.ida = trechos[0];
        ed.volta = trechos[1];
        ed.guia = { ida: [], volta: [] };
      } else {
        ed[ed.alvo] = trechos[0];
        ed.guia[ed.alvo] = [];
      }
      geometriaAlterada();
      enquadrarSelecao();
      toast('Traçado importado. Confira no mapa e clique em "Salvar traçado".');
    } catch (err) {
      toast(`Não foi possível importar: ${err.message}`, true);
    }
  }

  // ------------------------------------------------------------------ importar do Moovit
  // O favorito roda DENTRO do editor do Moovit (com o login da própria pessoa), pede os dados da
  // viagem aberta à mesma API que a página usa e baixa um arquivo .json. Nada de senha passa pelo BuzuRota.
  function favoritoExportarMoovit() {
    (async () => {
      try {
        const m = location.pathname.match(/\/editor\/trip\/(\d+)/);
        if (!/(^|\.)moovit\.com$/.test(location.hostname) || !m) {
          alert('Abra uma VIAGEM no editor do Moovit (endereço /editor/trip/…) e clique de novo no favorito.');
          return;
        }
        const ds = Number(new URLSearchParams(location.search).get('dataSourceId')) || undefined;
        const r = await fetch('/api/trip-settings/trip-settings-full-details-v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ tripSettingsId: Number(m[1]), dataSourceId: ds })
        });
        if (!r.ok) throw new Error(`o Moovit respondeu ${r.status}`);
        const fd = (await r.json()).fullDetails;
        if (!fd || !Array.isArray(fd.stops) || !Array.isArray(fd.stopPairSegments)) throw new Error('dados da viagem incompletos');
        // Só o caminho e as paradas: horários e frequências do Moovit ficam de fora (o BuzuRota usa os do edital)
        const saida = {
          formato: 'buzurota-moovit',
          versao: 2,
          exportado_em: new Date().toISOString(),
          viagem: Number(m[1]),
          endereco: location.href,
          linha: fd.shortName || '',
          nome: fd.longName || '',
          ativa: fd.isActive !== false,
          paradas: fd.stops.map(s => ({ id: s.stopId, nome: s.stopName, lat: s.location.latitude, lng: s.location.longitude })),
          trechos: fd.stopPairSegments.map(x => ({ de: x.fromStopId, para: x.toStopId, forma: x.encodedPolylineShape || '' }))
        };
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(saida)], { type: 'application/json' }));
        a.download = `moovit-${(fd.shortName || 'linha').replace(/[^\w-]+/g, '')}-${m[1]}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {
        alert(`Não consegui exportar esta viagem do Moovit: ${err.message}`);
      }
    })();
  }
  const HREF_FAVORITO_MOOVIT = `javascript:${encodeURIComponent(`(${favoritoExportarMoovit.toString()})()`)}`;

  /** Polilinha codificada (formato Google, 5 casas) → [[lng, lat], ...] */
  function decodificarPolilinha(str) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const eixo of ['lat', 'lng']) {
        let b, s = 0, r = 0;
        do {
          b = str.charCodeAt(i++) - 63;
          r |= (b & 31) << s;
          s += 5;
        } while (b >= 32);
        const d = r & 1 ? ~(r >> 1) : r >> 1;
        if (eixo === 'lat') lat += d;
        else lng += d;
      }
      out.push([arred(lng / 1e5), arred(lat / 1e5)]);
    }
    return out;
  }

  let importMoovit = null; // { dados, coords, idxParada, retorno }

  /** Monta o traçado do circuito e o índice (no traçado) de cada parada do Moovit */
  function prepararMoovit(dados) {
    const coords = [];
    const idxParada = [];
    dados.trechos.forEach((t, k) => {
      idxParada.push(coords.length ? coords.length - 1 : 0);
      let pts = decodificarPolilinha(t.forma || '');
      if (pts.length < 2) {
        const a = dados.paradas[k], b = dados.paradas[k + 1];
        pts = a && b ? [[arred(a.lng), arred(a.lat)], [arred(b.lng), arred(b.lat)]] : pts;
      }
      for (const p of pts) {
        const u = coords[coords.length - 1];
        if (!u || u[0] !== p[0] || u[1] !== p[1]) coords.push(p);
      }
    });
    idxParada.push(coords.length - 1);
    return { coords, idxParada };
  }

  // Paradas do Moovit que ainda não existem no BuzuRota (nenhuma parada ativa a até 25 m)
  const RAIO_PARADA_EXISTENTE_M = 25;
  function paradasQueFaltam(dados, iRet) {
    const ativas = paradas().filter(f => f.properties?.ativo !== false);
    const n = dados.paradas.length;
    const faltam = [];
    dados.paradas.forEach((p, i) => {
      if (i === n - 1 && dados.paradas[0] && U.calcularDistanciaGeodesica(p.lat, p.lng, dados.paradas[0].lat, dados.paradas[0].lng) < 30) return; // fim = início do circuito
      const perto = ativas.some(f => {
        const [x, y] = f.geometry.coordinates;
        return Math.abs(y - p.lat) < 0.001 && Math.abs(x - p.lng) < 0.001 && U.calcularDistanciaGeodesica(p.lat, p.lng, y, x) <= RAIO_PARADA_EXISTENTE_M;
      });
      if (perto || faltam.some(q => U.calcularDistanciaGeodesica(p.lat, p.lng, q.lat, q.lng) <= RAIO_PARADA_EXISTENTE_M)) return;
      const [rua, referencia] = String(p.nome || '').split('|').map(s => s.replace(/\s+/g, ' ').trim());
      faltam.push({
        id: `MOV-${p.id || `${arred(p.lat)}_${arred(p.lng)}`}`,
        nome: (referencia ? `${rua} — ${referencia}` : rua || 'Parada').slice(0, 120),
        lat: arred(p.lat),
        lng: arred(p.lng),
        tipo: /terminal/i.test(p.nome) ? 'terminal' : 'parada',
        // no circuito, a parada fica do lado da via do sentido em que o ônibus passa
        sentido: i < iRet ? 'IDA' : i > iRet ? 'VOLTA' : 'AMBOS'
      });
    });
    return faltam;
  }

  /**
   * Sugere o retorno de um circuito: o ponto em que ida e volta ficam mais "espelhadas"
   * (cada parada de um lado tem uma parada perto do outro lado). Num laço no fim da linha
   * vários pontos empatam; entre os empatados (até 4% de diferença) fica o último, que é
   * onde a volta de fato começa.
   */
  function sugerirRetorno(dados) {
    const P = dados.paradas.map(p => [p.lng, p.lat]);
    const n = P.length;
    if (n < 5) return Math.max(1, Math.floor(n / 2));
    const d = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180) * 111320, (b[1] - a[1]) * 110540);
    const custos = [];
    for (let i = 2; i < n - 2; i++) {
      let c = 0;
      for (let j = 0; j <= i; j++) { let m = Infinity; for (let k = i; k < n; k++) m = Math.min(m, d(P[j], P[k])); c += m; }
      for (let j = i; j < n; j++) { let m = Infinity; for (let k = 0; k <= i; k++) m = Math.min(m, d(P[j], P[k])); c += m; }
      custos.push({ i, c });
    }
    const menor = Math.min(...custos.map(x => x.c));
    return Math.max(...custos.filter(x => x.c <= menor * 1.04).map(x => x.i));
  }

  function abrirDialogoMoovit() {
    if (!ed) {
      toast('Abra primeiro a linha e o dia que vão receber o traçado.', true);
      return;
    }
    $('#moovit-passo-1').hidden = false;
    $('#moovit-passo-2').hidden = true;
    $('#dlg-moovit').showModal();
  }

  function mostrarImportMoovit(dados) {
    if (!ed) return;
    if (!Array.isArray(dados.paradas) || !Array.isArray(dados.trechos) || dados.trechos.length !== dados.paradas.length - 1) {
      throw new Error('o arquivo do Moovit está incompleto (paradas e trechos não batem)');
    }
    const { coords, idxParada } = prepararMoovit(dados);
    if (coords.length < 3) throw new Error('o traçado do Moovit veio vazio');
    importMoovit = { dados, coords, idxParada };

    const avisos = [];
    const linhaMoovit = String(dados.linha || '').toUpperCase().replace(/\s+/g, '');
    if (linhaMoovit && linhaMoovit !== String(ed.numero).toUpperCase()) {
      avisos.push(`O arquivo é da linha <strong>${esc(dados.linha)}</strong>, mas você está editando a <strong>${esc(ed.numero)}</strong>.`);
    }
    if (dados.ativa === false) avisos.push('Esta viagem está <strong>inativa</strong> no Moovit (pode estar desatualizada).');

    $('#moovit-resumo').innerHTML = `
      <div class="ed-moovit-resumo">
        <div>Linha no Moovit<strong>${esc(dados.linha || '—')}</strong></div>
        <div>Viagem<strong>${esc(dados.nome || dados.viagem)}</strong></div>
        <div>Vai para<strong>${esc(ed.numero)} • ${esc(DIAS[ed.dia])}</strong></div>
        <div>Circuito<strong>${fmtKm(comprimento(coords))} • ${fmtNum(dados.paradas.length)} paradas</strong></div>
      </div>
      <p>Só o caminho e as paradas vêm do Moovit. Horários e frequências continuam os do edital.</p>
      ${avisos.length ? `<div class="ed-validacao ed-validacao--alerta"><ul>${avisos.map(a => `<li>${a}</li>`).join('')}</ul></div>` : ''}`;

    const sugerido = sugerirRetorno(dados);
    $('#moovit-retorno').innerHTML = dados.paradas
      .map((p, i) =>
        i === 0 || i === dados.paradas.length - 1
          ? ''
          : `<option value="${i}" ${i === sugerido ? 'selected' : ''}>${i + 1}. ${esc(p.nome)}${i === sugerido ? ' (sugerido: o ponto mais longe do início)' : ''}</option>`
      )
      .join('');
    const info = () => {
      const i = Number($('#moovit-retorno').value);
      const ret = idxParada[i];
      const novas = paradasQueFaltam(dados, i).length;
      $('#moovit-retorno-info').textContent =
        `Ida: paradas 1 a ${i + 1} (${fmtKm(comprimento(coords.slice(0, ret + 1)))}) • Volta: paradas ${i + 1} a ${dados.paradas.length} (${fmtKm(comprimento(coords.slice(ret)))}). ` +
        (novas
          ? `${novas} parada(s) do Moovit ainda não existem no BuzuRota e serão criadas ao salvar; as outras já existem e são ligadas à linha.`
          : 'Todas as paradas do Moovit já existem no BuzuRota e serão ligadas à linha.');
    };
    $('#moovit-retorno').onchange = info;
    info();
    $('#moovit-passo-1').hidden = true;
    $('#moovit-passo-2').hidden = false;
    if (!$('#dlg-moovit').open) $('#dlg-moovit').showModal();
  }

  /** Lista de ruas a partir dos nomes das paradas do Moovit ("Av. Tal, 123 | Referência") */
  function ruasDasParadasMoovit(paradas) {
    const estado = D.obterEstado();
    const bairroPerto = (lat, lng) => {
      let m = null;
      for (const f of estado.paradas?.features || []) {
        const b = f.properties?.bairro;
        if (!b) continue;
        const [x, y] = f.geometry.coordinates;
        if (Math.abs(y - lat) > 0.01 || Math.abs(x - lng) > 0.01) continue;
        const d = U.calcularDistanciaGeodesica(lat, lng, y, x);
        if (!m || d < m.d) m = { d, b };
      }
      return m && m.d < 600 ? m.b : 'Natal';
    };
    // mesma rua com grafias diferentes ("Av." / "Avenida", "Faria" / "Farias") conta uma vez só
    const chave = s =>
      U.normalizarTexto(s)
        .replace(/^(av\.?|avenida)\s+/, 'av ')
        .replace(/^(r\.|rua)\s+/, 'rua ')
        .replace(/[^a-z0-9 ]/g, '')
        .trim();
    const mesma = (a, b) => {
      const x = chave(a), y = chave(b);
      return x === y || x.startsWith(y) || y.startsWith(x);
    };
    const lista = [];
    for (const p of paradas) {
      let nome = String(p.nome || '').split('|')[0].split(',')[0].replace(/\s+/g, ' ').trim();
      if (!/^(rua|r\.|av\.?|avenida|travessa|tv\.|praça|pça|estrada|rodovia|br-|rn-|alameda|ponte|viaduto|túnel)(\s|$)/i.test(nome)) continue;
      nome = nome.replace(/ (De|Da|Do|Das|Dos|E) /g, m => m.toLowerCase());
      const ult = lista[lista.length - 1];
      if (ult && mesma(ult.logradouro, nome)) continue;
      lista.push({ ordem: lista.length + 1, logradouro: nome, bairro: bairroPerto(p.lat, p.lng), lat: arred(p.lat), lng: arred(p.lng) });
    }
    return lista;
  }

  function aplicarImportMoovit() {
    if (!ed || !importMoovit) return;
    const { dados, coords, idxParada } = importMoovit;
    const iRet = Number($('#moovit-retorno').value);
    const ret = idxParada[iRet];
    if (!(ret > 0 && ret < coords.length - 1)) {
      toast('Escolha um ponto de retorno no meio do trajeto.', true);
      return;
    }
    registrarPasso();
    ed.ida = coords.slice(0, ret + 1);
    ed.volta = coords.slice(ret);
    ed.guia = { ida: [], volta: [] };
    ed.importMoovit = {
      itinerario_ruas: {
        ida: ruasDasParadasMoovit(dados.paradas.slice(0, iRet + 1)),
        volta: ruasDasParadasMoovit(dados.paradas.slice(iRet))
      },
      paradasNovas: paradasQueFaltam(dados, iRet),
      fonte_rota: {
        tipo: 'Moovit (comunidade)',
        referencia: `Viagem ${dados.viagem}${dados.nome ? ` "${dados.nome}"` : ''} — só traçado e paradas (horários e frequências seguem o edital)`,
        consultado_em: String(dados.exportado_em || '').slice(0, 10),
        metodo: `Traçado e paradas exportados do editor do Moovit; volta a partir de ${dados.paradas[iRet].nome}`
      }
    };
    importMoovit = null;
    geometriaAlterada();
    enquadrarSelecao();
    const novas = ed.importMoovit.paradasNovas.length;
    toast(
      `Traçado do Moovit carregado (${fmtKm(comprimento(coords))}${novas ? `; ${novas} parada(s) nova(s) serão criadas ao salvar` : ''}). Confira no mapa e clique em "Salvar traçado".`
    );
  }

  function exportarGeoJson(numero) {
    const l = linhaDe(numero);
    const feats = [];
    for (const s of ['ida', 'volta']) {
      const cs = coordsAtuais(s);
      if (cs.length > 1) feats.push({ type: 'Feature', properties: { numero, nome: l?.nome, sentido: s.toUpperCase(), dia_semana: S.dia, cor: corDe(l) }, geometry: { type: 'LineString', coordinates: cs } });
    }
    for (const v of vinculosLinha(numero)) {
      const f = paradaDe(v.parada_id);
      if (f) feats.push({ type: 'Feature', properties: { parada_id: v.parada_id, nome: f.properties.nome, sentido: v.sentido, ordem: v.ordem_sequencial }, geometry: f.geometry });
    }
    baixar(`linha-${numero}-${S.dia}.geojson`, JSON.stringify({ type: 'FeatureCollection', features: feats }, null, 1), 'application/geo+json');
  }

  function exportarKml(numero) {
    const l = linhaDe(numero);
    const xml = s => esc(s);
    const cor = corDe(l).replace('#', '');
    const kmlCor = `ff${cor.slice(4, 6)}${cor.slice(2, 4)}${cor.slice(0, 2)}`;
    const marcas = ['ida', 'volta']
      .map(s => {
        const cs = coordsAtuais(s);
        if (cs.length < 2) return '';
        return `<Placemark><name>${xml(numero)} — ${s.toUpperCase()}</name><Style><LineStyle><color>${kmlCor}</color><width>4</width></LineStyle></Style><LineString><tessellate>1</tessellate><coordinates>${cs.map(c => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LineString></Placemark>`;
      })
      .join('');
    const paradasKml = vinculosLinha(numero)
      .map(v => {
        const f = paradaDe(v.parada_id);
        if (!f) return '';
        const [lng, lat] = f.geometry.coordinates;
        return `<Placemark><name>${v.sentido === 'VOLTA' ? 'V' : 'I'}${v.ordem_sequencial} ${xml(f.properties.nome)}</name><Point><coordinates>${lng},${lat},0</coordinates></Point></Placemark>`;
      })
      .join('');
    const doc = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(numero)} — ${xml(l?.nome || '')}</name>${marcas}<Folder><name>Paradas</name>${paradasKml}</Folder></Document></kml>`;
    baixar(`linha-${numero}-${S.dia}.kml`, doc, 'application/vnd.google-earth.kml+xml');
  }

  // ------------------------------------------------------------------ busca
  let resultadosBusca = [];
  let idxBusca = -1;
  let timerBusca = null;

  function montarBusca() {
    const inp = $('#ed-busca');
    const lista = $('#ed-busca-lista');
    const fechar = () => {
      lista.hidden = true;
      inp.setAttribute('aria-expanded', 'false');
    };
    const mostrar = () => {
      lista.innerHTML = resultadosBusca
        .map((r, i) => `<li role="option" data-i="${i}" aria-selected="${i === idxBusca}"><i class="bi ${r.icone}"></i><span>${r.html}</span></li>`)
        .join('');
      lista.hidden = !resultadosBusca.length;
      inp.setAttribute('aria-expanded', String(!lista.hidden));
      lista.querySelectorAll('[data-i]').forEach(li => li.addEventListener('mousedown', e => {
        e.preventDefault();
        escolher(Number(li.dataset.i));
      }));
    };
    const escolher = async i => {
      const r = resultadosBusca[i];
      if (!r) return;
      fechar();
      inp.blur();
      await r.acao();
    };
    inp.addEventListener('input', () => {
      clearTimeout(timerBusca);
      timerBusca = setTimeout(() => {
        const t = U.normalizarTexto(inp.value);
        idxBusca = -1;
        if (t.length < 1) {
          resultadosBusca = [];
          return mostrar();
        }
        const rl = linhas()
          .filter(l => U.normalizarTexto(`${l.numero} ${l.nome}`).includes(t))
          .slice(0, 6)
          .map(l => ({ icone: 'bi-bus-front', html: `<strong>${esc(l.numero)}</strong> ${esc(l.nome)}`, acao: () => selecionarLinha(String(l.numero).toUpperCase()) }));
        const rp =
          t.length >= 3
            ? paradas()
                .filter(f => U.normalizarTexto(`${f.properties.nome} ${f.properties.id}`).includes(t))
                .slice(0, 6)
                .map(f => ({ icone: 'bi-geo-alt', html: `${esc(f.properties.nome)} <small>${esc(f.properties.bairro || f.properties.id)}</small>`, acao: () => selecionarParada(f.properties.id, true) }))
            : [];
        const ra =
          inp.value.trim().length >= 4
            ? [{ icone: 'bi-search', html: `Buscar endereço: <strong>${esc(inp.value.trim())}</strong>`, acao: () => buscarEndereco(inp.value.trim()) }]
            : [];
        resultadosBusca = [...rl, ...rp, ...ra];
        mostrar();
      }, 120);
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!resultadosBusca.length) return;
        idxBusca = (idxBusca + (e.key === 'ArrowDown' ? 1 : -1) + resultadosBusca.length) % resultadosBusca.length;
        mostrar();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        escolher(idxBusca >= 0 ? idxBusca : 0);
      } else if (e.key === 'Escape') {
        fechar();
        inp.blur();
      }
    });
    inp.addEventListener('blur', () => setTimeout(fechar, 150));
  }

  async function buscarEndereco(texto) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=br&viewbox=-35.45,-5.60,-35.10,-6.05&bounded=1&accept-language=pt-BR&q=${encodeURIComponent(texto)}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const lista = await r.json();
      if (!lista.length) {
        toast('Endereço não encontrado na região de Natal.', true);
        return;
      }
      resultadosBusca = lista.map(x => ({
        icone: 'bi-pin-map',
        html: esc(x.display_name),
        acao: () => {
          const ll = [Number(x.lat), Number(x.lon)];
          G.temp.clearLayers();
          L.circleMarker(ll, { radius: 9, color: '#e11d48', weight: 3, fillColor: '#fff', fillOpacity: 0.9 }).bindPopup(esc(x.display_name)).addTo(G.temp).openPopup();
          mapa.setView(ll, 17);
        }
      }));
      idxBusca = 0;
      const inp = $('#ed-busca');
      inp.focus();
      inp.dispatchEvent(new Event('keydown'));
      $('#ed-busca-lista').innerHTML = resultadosBusca.map((rr, i) => `<li role="option" data-i="${i}"><i class="bi ${rr.icone}"></i><span>${rr.html}</span></li>`).join('');
      $('#ed-busca-lista').hidden = false;
      $('#ed-busca-lista').querySelectorAll('[data-i]').forEach(li => li.addEventListener('mousedown', e => {
        e.preventDefault();
        $('#ed-busca-lista').hidden = true;
        resultadosBusca[Number(li.dataset.i)].acao();
      }));
    } catch (_e) {
      toast('Busca de endereço indisponível agora.', true);
    }
  }

  // ------------------------------------------------------------------ rascunho, desfazer, publicar
  function atualizarStatusRascunho() {
    const st = D.obterStatusRascunho();
    const el = $('#ed-status-rascunho');
    if (st.ultimoStatus?.tipo === 'erro') {
      el.className = 'ed-status ed-status--erro';
      el.textContent = 'Erro ao salvar';
      el.title = st.ultimoStatus.texto;
    } else if (st.pendente) {
      el.className = 'ed-status ed-status--rascunho';
      el.textContent = `Rascunho: ${st.qtdAcoes} alteraç${st.qtdAcoes === 1 ? 'ão' : 'ões'}`;
      el.title = 'Salvo neste navegador. Clique em Publicar para enviar ao site.';
    } else {
      el.className = 'ed-status ed-status--ok';
      el.textContent = 'Tudo publicado';
      el.title = 'Não há alterações pendentes.';
    }
    renderListaAlteracoes();
  }

  async function desfazer() {
    if (ed && ed.pilha.length) {
      desfazerTracado();
      return;
    }
    const st = D.obterStatusRascunho();
    if (!st.qtdUndo) {
      toast('Nada para desfazer.');
      return;
    }
    ocupado(true, 'Desfazendo…');
    try {
      const r = await D.desfazerUltimaAlteracaoAdmin();
      if (S.sel?.tipo === 'linha') {
        if (!linhaDe(S.sel.numero)) S.sel = null;
        else abrirSessao(S.sel.numero);
      }
      if (S.sel?.tipo === 'parada' && !paradaDe(S.sel.id)) S.sel = null;
      toast(r.ok ? `Desfeito: ${r.rotulo}` : r.mensagem);
      depoisDeAlterarDados();
    } finally {
      ocupado(false);
    }
  }

  function abrirPublicar() {
    if (ed?.sujo) {
      toast(`Salve (ou descarte) o traçado da linha ${ed.numero} antes de publicar.`, true);
      return;
    }
    const st = D.obterStatusRascunho();
    if (!st.pendente) {
      toast('Não há alterações para publicar.');
      return;
    }
    const pacote = { ...D.exportarPacoteCompletoJson() };
    const v = D.validarPacoteAntesDeSalvar(pacote);
    const caixa = $('#dlg-publicar-validacao');
    caixa.innerHTML = !v.valido
      ? `<div class="ed-validacao ed-validacao--erro"><strong>A publicação está bloqueada:</strong><ul>${v.erros.slice(0, 12).map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`
      : `<div class="ed-validacao ed-validacao--ok"><i class="bi bi-check-circle-fill"></i> Dados verificados: nenhum erro bloqueante.</div>${
          v.avisos.length ? `<div class="ed-validacao ed-validacao--alerta"><ul>${v.avisos.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''
        }`;
    $('#dlg-publicar-ok').disabled = !v.valido;
    $('#dlg-publicar-resumo').value = st.acoes
      .slice(-6)
      .map(a => a.replace(/^\d{2}:\d{2}:\d{2} — /, ''))
      .join('; ')
      .slice(0, 400);
    $('#dlg-publicar').showModal();
  }

  async function publicar() {
    const resumo = $('#dlg-publicar-resumo').value.trim();
    ocupado(true, 'Publicando no site…');
    try {
      const r = await D.publicarRascunhoNoServidor(resumo || 'Publicação pelo editor do mapa');
      if (r.okServidor) toast(`Publicado no site!${r.versaoBackup ? ` Cópia anterior guardada (${r.versaoBackup}).` : ''}`);
      else if (r.status === 'erro_validacao') toast(`Publicação bloqueada: ${r.mensagem}`, true);
      else toast(`O servidor recusou: ${r.erroServidor || r.mensagem}. O rascunho continua salvo aqui.`, true);
      if (/sess|autoriz|401/i.test(String(r.erroServidor || ''))) toast('Sua sessão terminou. Entre de novo no painel (o rascunho continua salvo).', true);
      depoisDeAlterarDados();
    } finally {
      ocupado(false);
    }
  }

  // ------------------------------------------------------------------ nova linha
  function abrirNovaLinha() {
    const sel = $('#nl-categoria');
    sel.innerHTML = CATEGORIAS.map(c => `<option>${esc(c)}</option>`).join('');
    $('#nl-erro').hidden = true;
    $('#form-nova-linha').reset();
    $('#nl-cor').value = PALETA[Math.floor(Math.random() * PALETA.length)];
    $('#dlg-nova-linha').showModal();
    $('#nl-numero').focus();
  }

  async function criarLinha() {
    const numero = $('#nl-numero').value.trim().toUpperCase();
    const nome = $('#nl-nome').value.trim();
    const erro = $('#nl-erro');
    if (!/^[A-Z0-9][A-Z0-9-]{0,9}$/.test(numero)) erro.textContent = 'Use só letras, números e hífen no código (ex.: B12).';
    else if (linhaDe(numero)) erro.textContent = `Já existe a linha ${numero}.`;
    else if (!nome) erro.textContent = 'Informe o nome da linha.';
    else erro.textContent = '';
    if (erro.textContent) {
      erro.hidden = false;
      return false;
    }
    const categoria = $('#nl-categoria').value;
    const tipo = /corujão/i.test(categoria) ? 'noturna' : /direta/i.test(categoria) ? 'expressa' : /bairro/i.test(categoria) ? 'alimentadora' : /atual/i.test(categoria) ? 'atual' : 'convencional';
    D.registrarSnapshotUndoAdmin(`Nova linha ${numero}`);
    E().indice.linhas.push({
      id: numero,
      numero,
      nome,
      lote: $('#nl-lote').value,
      empresa: null,
      tipo,
      categoria_edital: categoria,
      sentido: 'ambos',
      cor: $('#nl-cor').value.toUpperCase(),
      acessivel: true,
      tarifa: '',
      frequencia_pico: '',
      frequencia_entre_pico: '',
      ordem_confirmada_por_sentido: false,
      dias_disponiveis: [S.dia],
      variantes_dia: {},
      bbox: null,
      rede: 'transicao',
      situacao_rota: 'indefinida'
    });
    await D.salvarOverrideAdmin({ publicar: false, resumoAcao: `Linha ${numero} criada` });
    toast(`Linha ${numero} criada. Agora marque os pontos-guia pelas ruas para desenhar a ida.`);
    S.sel = { tipo: 'linha', numero };
    abrirSessao(numero);
    S.subaba = 'tracado';
    depoisDeAlterarDados();
    definirFerramenta('rotear');
    return true;
  }

  // ------------------------------------------------------------------ geral
  let contOcupado = 0;
  function ocupado(sim, texto) {
    contOcupado = Math.max(0, contOcupado + (sim ? 1 : -1));
    document.body.style.cursor = contOcupado ? 'progress' : '';
    if (sim && texto) dicaTemporaria(texto, 15000);
    if (!contOcupado) atualizarDica();
  }

  function atualizarResumo() {
    const feats = featuresDoDia();
    $('#ed-resumo-dados').textContent = `${fmtNum(linhas().length)} linhas • ${fmtNum(new Set(feats.map(numeroDe)).size)} com traçado em ${S.dia === 'domingos_feriados' ? 'Dom/Feriado' : 'Úteis/Sáb'} • ${fmtNum(paradas().length)} paradas`;
  }

  function renderListas() {
    renderListaLinhas();
    if (S.abaEsq === 'paradas') renderListaParadas();
    renderListaAlteracoes();
  }

  function renderTudo() {
    renderFantasma();
    renderParadas();
    renderSelecao();
    renderEdicao();
    renderListas();
    renderInspetor();
    atualizarResumo();
    atualizarDica();
  }

  function depoisDeAlterarDados() {
    if (S.sel?.tipo === 'linha' && ed && !ed.sujo) abrirSessao(S.sel.numero);
    renderTudo();
    agendarDiagnostico();
    atualizarStatusRascunho();
  }

  function definirDia(dia) {
    if (dia === S.dia) return;
    if (!confirmarDescarteSessao()) return;
    S.dia = dia;
    $$('.ed-dia [data-dia]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.dia === dia)));
    if (S.sel?.tipo === 'linha') abrirSessao(S.sel.numero);
    renderTudo();
    agendarDiagnostico();
  }

  function trocarAbaEsquerda(aba) {
    S.abaEsq = aba;
    $$('[data-aba-esq]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.abaEsq === aba)));
    $$('[data-painel-esq]').forEach(p => (p.hidden = p.dataset.painelEsq !== aba));
    if (aba === 'paradas') renderListaParadas();
    if (aba === 'problemas') renderProblemas();
    if (aba === 'alteracoes') renderListaAlteracoes();
  }

  function montarCamadasUI() {
    const btn = $('#ed-btn-camadas');
    const menu = $('#ed-camadas-menu');
    btn.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
    L.DomEvent.disableClickPropagation($('#ed-camadas'));
    L.DomEvent.disableScrollPropagation($('#ed-camadas'));
    const radio = (nome, chave, depois) => {
      $$(`input[name="${nome}"]`).forEach(r => {
        r.checked = r.value === prefs[chave];
        r.addEventListener('change', () => {
          prefs[chave] = r.value;
          salvarPrefs();
          depois();
        });
      });
    };
    radio('ed-fundo', 'fundo', aplicarFundo);
    radio('ed-cor-linhas', 'corLinhas', renderFantasma);
    const check = (id, chave, depois) => {
      const c = $(id);
      c.checked = Boolean(prefs[chave]);
      c.addEventListener('change', () => {
        prefs[chave] = c.checked;
        salvarPrefs();
        depois();
      });
    };
    check('#ed-ver-linhas', 'verLinhas', renderFantasma);
    check('#ed-ver-paradas', 'verParadas', renderParadas);
    check('#ed-paradas-sempre', 'paradasSempre', renderParadas);
    check('#ed-ver-inativas', 'verInativas', renderParadas);
    check('#ed-ver-nomes', 'verNomes', renderParadas);
    check('#ed-ver-setas', 'verSetas', renderSelecao);
    check('#ed-ver-ordem', 'verOrdem', renderSelecao);
    const slider = (id, chave, depois) => {
      const s = $(id);
      s.value = prefs[chave];
      s.addEventListener('input', () => {
        prefs[chave] = Number(s.value);
        salvarPrefs();
        depois();
      });
    };
    slider('#ed-opac-fundo', 'opacFundo', aplicarOpacidadeFundo);
    slider('#ed-opac-linhas', 'opacLinhas', renderFantasma);
    slider('#ed-espessura', 'espessura', renderSelecao);
  }

  function montarUI() {
    $$('.ed-dia [data-dia]').forEach(b => b.addEventListener('click', () => definirDia(b.dataset.dia)));
    $$('.ed-ferr').forEach(b => b.addEventListener('click', () => definirFerramenta(b.dataset.ferramenta)));
    $$('[data-aba-esq]').forEach(b => b.addEventListener('click', () => trocarAbaEsquerda(b.dataset.abaEsq)));
    ['#ed-filtro-linhas', '#ed-filtro-lote', '#ed-filtro-situacao'].forEach(s => $(s).addEventListener('input', renderListaLinhas));
    ['#ed-filtro-paradas', '#ed-filtro-tipo', '#ed-filtro-ativa'].forEach(s => $(s).addEventListener('input', renderListaParadas));
    $('#ed-filtro-problemas').addEventListener('input', renderProblemas);
    $('#ed-nova-linha').addEventListener('click', abrirNovaLinha);
    $('#form-nova-linha').addEventListener('submit', async e => {
      if (e.submitter?.value !== 'criar') return;
      e.preventDefault();
      if (await criarLinha()) $('#dlg-nova-linha').close();
    });
    $('#ed-desfazer').addEventListener('click', desfazer);
    $('#ed-refazer').addEventListener('click', () => {
      if (!refazerTracado()) toast('Nada para refazer.');
    });
    $('#ed-publicar').addEventListener('click', abrirPublicar);
    $('#form-publicar').addEventListener('submit', e => {
      if (e.submitter?.value === 'publicar') {
        e.preventDefault();
        $('#dlg-publicar').close();
        publicar();
      }
    });
    $('#ed-previa').addEventListener('click', () => {
      if (ed?.sujo) toast('O traçado em edição ainda não foi salvo, então não aparece na prévia.');
      window.open('/?previa=1', '_blank', 'noopener');
    });
    $('#ed-descartar').addEventListener('click', async () => {
      if (!confirm('Descartar TODO o rascunho deste navegador e voltar aos dados publicados no site? Isso não pode ser desfeito.')) return;
      await D.descartarRascunhoLocal();
      await Promise.all(['1', '2'].map(id => D.carregarGeoJsonLote(id)));
      ed = null;
      S.sel = null;
      toast('Rascunho descartado. Dados publicados recarregados.');
      depoisDeAlterarDados();
    });
    $('#ed-baixar-pacote').addEventListener('click', () => {
      baixar(`buzurota-dados-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(D.exportarPacoteCompletoJson()), 'application/json');
    });
    $('#ed-ajuda').addEventListener('click', () => $('#dlg-ajuda').showModal());
    $('#ed-tema').addEventListener('click', () => {
      tema = tema === 'escuro' ? 'claro' : 'escuro';
      try {
        localStorage.setItem('buzu_tema', tema);
      } catch (_e) {}
      aplicarTema();
      if (prefs.fundo === 'claro' || prefs.fundo === 'escuro') {
        prefs.fundo = tema === 'escuro' ? 'escuro' : 'claro';
        $$('input[name="ed-fundo"]').forEach(r => (r.checked = r.value === prefs.fundo));
        salvarPrefs();
        aplicarFundo();
      }
      renderSelecao();
    });
    $('#ed-coord').addEventListener('click', () => {
      const t = $('#ed-coord').textContent;
      if (t && t !== '—') navigator.clipboard?.writeText(t).then(() => toast(`Coordenada copiada: ${t}`));
    });
    $('#moovit-favorito').setAttribute('href', HREF_FAVORITO_MOOVIT);
    $('#moovit-favorito').addEventListener('click', e => {
      e.preventDefault();
      toast('Arraste este botão para a barra de favoritos e use-o dentro do editor do Moovit.');
    });
    $('#moovit-escolher').addEventListener('click', () => $('#ed-arquivo').click());
    $('#form-moovit').addEventListener('submit', e => {
      if (e.submitter?.value === 'usar') aplicarImportMoovit();
      else importMoovit = null;
    });
    $('#ed-arquivo').addEventListener('change', e => {
      const a = e.target.files?.[0];
      e.target.value = '';
      if (a) importarArquivo(a);
    });
    montarCamadasUI();
    montarBusca();
    D.inscreverStatusRascunho(atualizarStatusRascunho);

    window.addEventListener('beforeunload', e => {
      if (ed?.sujo) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    document.addEventListener('keydown', e => {
      const emCampo = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        $('#ed-busca').focus();
        $('#ed-busca').select();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (ed?.sujo) salvarTracado();
        else toast('Não há traçado alterado para salvar.');
        return;
      }
      if (emCampo || document.querySelector('dialog[open]')) return;
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        desfazer();
        return;
      }
      if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (!refazerTracado()) toast('Nada para refazer.');
        return;
      }
      if (ctrl || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        if (S.ferramenta === 'medir' && S.medida.length) {
          S.medida = [];
          renderMedida();
        } else if (S.ferramenta !== 'selecionar') definirFerramenta('selecionar');
        else limparSelecao();
      } else if (k === 'v') definirFerramenta('selecionar');
      else if (k === 'e') definirFerramenta('vertices');
      else if (k === 'd') definirFerramenta('desenhar');
      else if (k === 'r') definirFerramenta('rotear');
      else if (k === 'p') definirFerramenta('parada');
      else if (k === 'm') definirFerramenta('medir');
      else if (k === 'f') enquadrarSelecao();
      else if (k === '1') definirAlvo('ida');
      else if (k === '2') definirAlvo('volta');
      else if (k === '?' || (e.shiftKey && k === '/')) $('#dlg-ajuda').showModal();
      else if ((k === 'delete' || k === 'backspace') && ed && Number.isInteger(ed.verticeSel)) {
        e.preventDefault();
        removerVertice(ed.verticeSel);
      }
    });
  }

  function bloquear(titulo, texto) {
    $('#ed-carregando').hidden = true;
    $('#ed-bloqueio-titulo').textContent = titulo;
    $('#ed-bloqueio-texto').textContent = texto;
    $('#ed-bloqueio').hidden = false;
  }

  // ------------------------------------------------------------------ início
  (async () => {
    let sessao = null;
    try {
      sessao = await (await fetch('/api/painel/sessao', { credentials: 'same-origin', cache: 'no-store' })).json();
    } catch (_e) {}
    if (!sessao?.autenticado) {
      bloquear('Entre no painel', 'O editor do mapa é exclusivo da equipe. Faça login no painel e abra o editor de novo.');
      return;
    }
    if (typeof L === 'undefined' || !D || !U) {
      bloquear('Não foi possível carregar', 'As bibliotecas do mapa não carregaram. Verifique a internet e recarregue a página.');
      return;
    }
    try {
      await D.inicializar();
      await Promise.all(['1', '2'].map(id => D.carregarGeoJsonLote(id)));
    } catch (err) {
      bloquear('Erro ao carregar os dados', err.message);
      return;
    }
    $('#ed-app').hidden = false;
    $('#ed-carregando').hidden = true;
    montarMapa();
    montarUI();
    renderTudo();
    const paramsUrl = new URLSearchParams(location.search);
    const diaUrl = paramsUrl.get('dia');
    if (diaUrl && DIAS[diaUrl]) definirDia(diaUrl);
    const linhaUrl = paramsUrl.get('linha');
    if (linhaUrl) {
      const alvoLinha = linhaDe(linhaUrl.trim().toUpperCase());
      if (alvoLinha) selecionarLinha(alvoLinha.numero, true);
    }
    atualizarStatusRascunho();
    diagnosticar();
    if (D.obterStatusRascunho().pendente) {
      toast('Você tem um rascunho não publicado neste navegador. Ele foi carregado — veja a aba "Rascunho".');
    }
    if (window.innerWidth < 1000) toast('O editor foi feito para telas de computador. Em telas pequenas algumas partes ficam apertadas.');
  })();
})();
