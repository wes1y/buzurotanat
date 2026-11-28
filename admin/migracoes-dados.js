/**
 * admin/migracoes-dados.js
 * Migrações de dados: como uma mudança feita no GitHub chega ao site sem apagar o que foi
 * editado no /use-admin (que fica salvo no PostgreSQL).
 *
 * No deploy, o servidor restaura do banco linhas.json, paradas.json, linha_paradas.json e os
 * traçados (lote-1/2.geojson). Se alguém mudou esses arquivos no GitHub, a mudança se perderia.
 * Por isso cada mudança de dados no GitHub vem acompanhada de um arquivo em dados/migracoes/
 * com SÓ o que mudou (por linha, por parada, por traçado, por grupo linha+dia de vínculos).
 * Depois de restaurar o banco, o servidor aplica as migrações que ainda não rodaram e grava o
 * resultado de volta no banco. O que não foi tocado pela migração continua como está no banco.
 *
 * Gerar uma migração: npm run dados:migracao -- "descrição curta"
 */
'use strict';

/** Tipo de cada arquivo de dados gerenciado pelo banco */
const TIPOS = {
  'linhas.json': 'linhas',
  'paradas.json': 'paradas',
  'linha_paradas.json': 'vinculos',
  'lote-1.geojson': 'tracados',
  'lote-2.geojson': 'tracados'
};

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const chaveLinha = l => String(l?.numero ?? l?.id ?? '').trim().toUpperCase();
const chaveParada = f => String(f?.properties?.id ?? '');
const chaveTracado = f =>
  String(f?.properties?.id || `${f?.properties?.numero || f?.properties?.linha_id}-${f?.properties?.dia_semana}`);
const grupoVinculo = v => `${String(v?.linha_id ?? '').toUpperCase()}|${v?.dia_semana ?? ''}`;

function mapaPor(lista, chave) {
  const m = new Map();
  for (const item of lista || []) m.set(chave(item), item);
  return m;
}

/** O que mudou entre duas listas de entidades (adicionadas/alteradas e removidas) */
function diferencas(antes, depois, chave) {
  const A = mapaPor(antes, chave);
  const B = mapaPor(depois, chave);
  const upsert = [];
  const remover = [];
  for (const [k, v] of B) if (!A.has(k) || !igual(A.get(k), v)) upsert.push(v);
  for (const k of A.keys()) if (!B.has(k)) remover.push(k);
  return { upsert, remover };
}

/** Operações que levam `antes` a `depois` (null quando não mudou nada) */
function gerarOperacoes(tipo, antes, depois) {
  if (tipo === 'linhas') {
    const ops = diferencas(antes?.linhas, depois?.linhas, chaveLinha);
    const topo = {};
    // "empresas" vem da tabela buzu_empresas do banco: não entra na migração
    for (const k of Object.keys(depois || {})) {
      if (k !== 'linhas' && k !== 'empresas' && !igual(antes?.[k], depois[k])) topo[k] = depois[k];
    }
    if (Object.keys(topo).length) ops.topo = topo;
    return ops.upsert.length || ops.remover.length || ops.topo ? ops : null;
  }
  if (tipo === 'paradas' || tipo === 'tracados') {
    const ops = diferencas(antes?.features, depois?.features, tipo === 'paradas' ? chaveParada : chaveTracado);
    return ops.upsert.length || ops.remover.length ? ops : null;
  }
  if (tipo === 'vinculos') {
    const agrupar = lista => {
      const m = new Map();
      for (const v of lista || []) {
        const g = grupoVinculo(v);
        if (!m.has(g)) m.set(g, []);
        m.get(g).push(v);
      }
      return m;
    };
    const A = agrupar(antes);
    const B = agrupar(depois);
    const substituir = [];
    for (const g of new Set([...A.keys(), ...B.keys()])) {
      if (!igual(A.get(g) || [], B.get(g) || [])) substituir.push({ grupo: g, vinculos: B.get(g) || [] });
    }
    return substituir.length ? { substituir } : null;
  }
  throw new Error(`tipo de arquivo desconhecido: ${tipo}`);
}

/** Troca/insere entidades mantendo a posição das que já existiam */
function aplicarUpsert(lista, ops, chave) {
  const resultado = Array.isArray(lista) ? [...lista] : [];
  const remover = new Set((ops.remover || []).map(String));
  const novos = mapaPor(ops.upsert, chave);
  const vistos = new Set();
  for (let i = 0; i < resultado.length; i++) {
    const k = chave(resultado[i]);
    if (novos.has(k)) {
      resultado[i] = novos.get(k);
      vistos.add(k);
    }
  }
  for (const [k, v] of novos) if (!vistos.has(k)) resultado.push(v);
  return resultado.filter(item => !remover.has(chave(item)));
}

/** Aplica as operações de uma migração ao conteúdo atual (vindo do banco ou do disco) */
function aplicarOperacoes(tipo, dados, ops) {
  if (!ops) return dados;
  if (tipo === 'linhas') {
    const novo = { ...(dados || {}) };
    novo.linhas = aplicarUpsert(novo.linhas, ops, chaveLinha);
    Object.assign(novo, ops.topo || {});
    return novo;
  }
  if (tipo === 'paradas' || tipo === 'tracados') {
    const novo = { ...(dados || { type: 'FeatureCollection' }) };
    novo.features = aplicarUpsert(novo.features, ops, tipo === 'paradas' ? chaveParada : chaveTracado);
    return novo;
  }
  if (tipo === 'vinculos') {
    const grupos = new Set((ops.substituir || []).map(s => s.grupo));
    const mantidos = (Array.isArray(dados) ? dados : []).filter(v => !grupos.has(grupoVinculo(v)));
    return [...mantidos, ...(ops.substituir || []).flatMap(s => s.vinculos)];
  }
  throw new Error(`tipo de arquivo desconhecido: ${tipo}`);
}

/** Grava o JSON no mesmo formato (indentação, quebra de linha) do texto original */
function serializarComo(textoOriginal, dados) {
  const t = String(textoOriginal || '');
  const m = /^[[{]\r?\n( +)/.exec(t);
  let saida = m ? JSON.stringify(dados, null, m[1].length) : JSON.stringify(dados);
  if (/\n$/.test(t)) saida += '\n';
  if (t.includes('\r\n')) saida = saida.replace(/\r?\n/g, '\r\n');
  return saida;
}

module.exports = { TIPOS, gerarOperacoes, aplicarOperacoes, serializarComo };
