/**
 * scripts/gerar-migracao-dados.js
 * Gera dados/migracoes/<data>-<descrição>.json com o que mudou nos dados do site em relação a
 * uma versão do Git (padrão: origin/main). No deploy, o servidor aplica essa migração por cima
 * dos dados salvos no PostgreSQL, sem apagar o que foi editado no /use-admin.
 *
 * Uso:   npm run dados:migracao -- "descrição curta"
 *        npm run dados:migracao -- "descrição curta" --base origin/main
 *
 * Rode sempre que mudar à mão (ou por script) linhas.json, paradas.json, linha_paradas.json ou
 * lote-1/2.geojson, ANTES do commit. Mudanças feitas pelo painel e publicadas não precisam disso.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { TIPOS, gerarOperacoes } = require('../admin/migracoes-dados');

const RAIZ = path.join(__dirname, '..');
const args = process.argv.slice(2);
const iBase = args.indexOf('--base');
const base = iBase >= 0 ? args[iBase + 1] : 'origin/main';
const descricao = args.filter((_a, i) => iBase < 0 || (i !== iBase && i !== iBase + 1)).join(' ').trim();

if (!descricao) {
  console.error('Informe uma descrição: npm run dados:migracao -- "o que mudou"');
  process.exit(1);
}

function versaoNoGit(nome) {
  try {
    return execFileSync('git', ['show', `${base}:dados/${nome}`], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (_e) {
    return null; // arquivo novo nesta versão
  }
}

const arquivos = {};
const resumo = [];
for (const [nome, tipo] of Object.entries(TIPOS)) {
  const atual = path.join(RAIZ, 'dados', nome);
  if (!fs.existsSync(atual)) continue;
  const textoBase = versaoNoGit(nome);
  const antes = textoBase ? JSON.parse(textoBase) : tipo === 'vinculos' ? [] : {};
  const depois = JSON.parse(fs.readFileSync(atual, 'utf8'));
  const ops = gerarOperacoes(tipo, antes, depois);
  if (!ops) continue;
  arquivos[nome] = ops;
  if (ops.substituir) resumo.push(`${nome}: ${ops.substituir.length} grupo(s) linha+dia`);
  else resumo.push(`${nome}: ${ops.upsert.length} alterado(s)/novo(s), ${ops.remover.length} removido(s)${ops.topo ? `, campos: ${Object.keys(ops.topo).join(', ')}` : ''}`);
}

if (!Object.keys(arquivos).length) {
  console.log(`Nenhuma mudança nos dados em relação a ${base}. Nada a gerar.`);
  process.exit(0);
}

const hoje = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD no horário local
const slug = descricao
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 50);
const id = `${hoje}-${slug}`;
const pasta = path.join(RAIZ, 'dados', 'migracoes');
fs.mkdirSync(pasta, { recursive: true });
const destino = path.join(pasta, `${id}.json`);
fs.writeFileSync(destino, JSON.stringify({ id, descricao, criado_em: new Date().toISOString(), base, arquivos }) + '\n');

console.log(`Migração criada: dados/migracoes/${id}.json`);
for (const r of resumo) console.log(`  - ${r}`);
