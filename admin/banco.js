/**
 * admin/banco.js
 * Persistência opcional em PostgreSQL (Vertra Cloud / produção com disco efêmero).
 *
 * - Sem DATABASE_URL: opera em modo nulo (tudo continua nos arquivos locais, ideal para dev).
 * - Com DATABASE_URL: conecta usando SSL/mTLS automático do Vertra (PGSSLROOTCERT, PGSSLCERT, PGSSLKEY),
 *   cria as tabelas na inicialização, restaura os dados persistidos para o disco do container antes de
 *   abrir a porta HTTP, e sincroniza toda alteração feita no /use-admin de volta para o PostgreSQL.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function lerCertificado(valor) {
  const txt = String(valor || '').trim();
  if (!txt) return null;
  if (txt.includes('-----BEGIN')) return txt;
  try {
    if (fs.existsSync(txt)) return fs.readFileSync(txt, 'utf8');
  } catch (_e) {}
  return null;
}

function montarConfigPg(databaseUrl) {
  let connectionString = String(databaseUrl || '').trim();
  const ca = lerCertificado(process.env.PGSSLROOTCERT);
  const cert = lerCertificado(process.env.PGSSLCERT);
  const key = lerCertificado(process.env.PGSSLKEY);

  let ssl = false;
  if (ca || cert || key) {
    ssl = {
      ...(ca ? { ca } : {}),
      ...(cert ? { cert } : {}),
      ...(key ? { key } : {}),
      rejectUnauthorized: Boolean(ca)
    };
    // Remove sslmode da URL quando fornecemos certificados explícitos para o driver pg não sobrescrever ssl
    try {
      const u = new URL(connectionString);
      if (u.searchParams.has('sslmode')) {
        u.searchParams.delete('sslmode');
        connectionString = u.toString();
      }
    } catch (_e) {}
  } else if (/[?&]sslmode=(require|verify-ca|verify-full)/i.test(connectionString) || process.env.PGSSLMODE === 'require') {
    ssl = { rejectUnauthorized: false };
  }

  return {
    connectionString,
    ...(ssl ? { ssl } : {}),
    max: Math.max(2, Math.min(10, Number(process.env.BUZU_PG_POOL_MAX) || 5)),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  };
}

function gravarAtomico(caminho, conteudo) {
  const pasta = path.dirname(caminho);
  if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
  const temp = `${caminho}.tmp`;
  fs.writeFileSync(temp, conteudo, 'utf8');
  fs.renameSync(temp, caminho);
}

function criarBanco() {
  const url = String(process.env.DATABASE_URL || '').trim();
  let pool = null;
  let conectado = false;
  let ultimoErro = '';

  const estaAtivo = () => Boolean(conectado && pool);

  async function criarTabelas() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS buzu_documentos (
        chave TEXT PRIMARY KEY,
        conteudo TEXT NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_por TEXT NOT NULL DEFAULT ''
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS buzu_empresas (
        id TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        sigla TEXT NOT NULL DEFAULT '',
        lote TEXT NOT NULL DEFAULT '',
        cor TEXT NOT NULL DEFAULT '#12355B',
        telefone TEXT NOT NULL DEFAULT '',
        site TEXT NOT NULL DEFAULT '',
        observacao TEXT NOT NULL DEFAULT '',
        linhas JSONB NOT NULL DEFAULT '[]'::jsonb,
        criado_por TEXT NOT NULL DEFAULT '',
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_por TEXT NOT NULL DEFAULT '',
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Migrações de dados do GitHub já aplicadas sobre o conteúdo do banco (ver admin/migracoes-dados.js)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS buzu_migracoes (
        id TEXT PRIMARY KEY,
        descricao TEXT NOT NULL DEFAULT '',
        aplicado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS buzu_backups (
        versao TEXT PRIMARY KEY,
        meta JSONB NOT NULL,
        arquivos JSONB NOT NULL,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async function salvarDocumento(chave, conteudo, usuario = '') {
    if (!estaAtivo()) return false;
    const texto = typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo);
    await pool.query(
      `INSERT INTO buzu_documentos (chave, conteudo, atualizado_em, atualizado_por)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (chave) DO UPDATE
         SET conteudo = EXCLUDED.conteudo,
             atualizado_em = NOW(),
             atualizado_por = EXCLUDED.atualizado_por`,
      [String(chave), texto, String(usuario || '')]
    );
    return true;
  }

  async function anexarLinhaDocumento(chave, linhaTexto, maxLinhas = 1500) {
    if (!estaAtivo()) return false;
    const limpa = String(linhaTexto || '').trim();
    if (!limpa) return false;
    const r = await pool.query('SELECT conteudo FROM buzu_documentos WHERE chave = $1', [String(chave)]);
    const anteriores = r.rows[0]?.conteudo ? r.rows[0].conteudo.split(/\r?\n/).filter(Boolean) : [];
    anteriores.push(limpa);
    const finalTexto = anteriores.slice(-maxLinhas).join('\n') + '\n';
    await salvarDocumento(chave, finalTexto, '');
    return true;
  }

  async function salvarEmpresa(registro, linhas = []) {
    if (!estaAtivo() || !registro?.id) return false;
    await pool.query(
      `INSERT INTO buzu_empresas (id, nome, sigla, lote, cor, telefone, site, observacao, linhas, criado_por, criado_em, atualizado_por, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, COALESCE($11::timestamptz, NOW()), $12, COALESCE($13::timestamptz, NOW()))
       ON CONFLICT (id) DO UPDATE
         SET nome = EXCLUDED.nome,
             sigla = EXCLUDED.sigla,
             lote = EXCLUDED.lote,
             cor = EXCLUDED.cor,
             telefone = EXCLUDED.telefone,
             site = EXCLUDED.site,
             observacao = EXCLUDED.observacao,
             linhas = EXCLUDED.linhas,
             atualizado_por = EXCLUDED.atualizado_por,
             atualizado_em = EXCLUDED.atualizado_em`,
      [
        String(registro.id),
        String(registro.nome || ''),
        String(registro.sigla || ''),
        String(registro.lote || ''),
        String(registro.cor || '#12355B'),
        String(registro.telefone || ''),
        String(registro.site || ''),
        String(registro.observacao || ''),
        JSON.stringify(Array.isArray(linhas) ? linhas : []),
        String(registro.criadoPor || ''),
        registro.criadoEm || null,
        String(registro.atualizadoPor || ''),
        registro.atualizadoEm || null
      ]
    );
    return true;
  }

  async function excluirEmpresa(id) {
    if (!estaAtivo() || !id) return false;
    await pool.query('DELETE FROM buzu_empresas WHERE id = $1', [String(id)]);
    return true;
  }

  async function sincronizarTabelaEmpresasDoIndice(indice) {
    if (!estaAtivo() || !indice) return false;
    const empresas = Array.isArray(indice.empresas) ? indice.empresas : [];
    const linhasPorEmp = new Map();
    for (const emp of empresas) {
      if (emp?.id) linhasPorEmp.set(String(emp.id), []);
    }
    for (const l of indice.linhas || []) {
      const empId = l?.empresa_id ? String(l.empresa_id) : '';
      const num = String(l?.numero || l?.id || '').trim().toUpperCase();
      if (empId && num && linhasPorEmp.has(empId)) {
        linhasPorEmp.get(empId).push(num);
      }
    }
    const idsAtuais = empresas.map(e => String(e.id)).filter(Boolean);
    if (idsAtuais.length > 0) {
      await pool.query('DELETE FROM buzu_empresas WHERE NOT (id = ANY($1::text[]))', [idsAtuais]);
    } else {
      await pool.query('DELETE FROM buzu_empresas');
    }
    for (const emp of empresas) {
      if (!emp?.id) continue;
      await salvarEmpresa(emp, linhasPorEmp.get(String(emp.id)) || []);
    }
    return true;
  }

  async function salvarBackup(versao, meta, arquivosObj) {
    if (!estaAtivo() || !versao) return false;
    await pool.query(
      `INSERT INTO buzu_backups (versao, meta, arquivos, criado_em)
       VALUES ($1, $2::jsonb, $3::jsonb, NOW())
       ON CONFLICT (versao) DO UPDATE
         SET meta = EXCLUDED.meta,
             arquivos = EXCLUDED.arquivos`,
      [String(versao), JSON.stringify(meta || {}), JSON.stringify(arquivosObj || {})]
    );
    // Mantém apenas os 20 backups mais recentes no banco (mesmo limite do disco)
    await pool.query(`
      DELETE FROM buzu_backups
      WHERE versao NOT IN (
        SELECT versao FROM buzu_backups ORDER BY versao DESC LIMIT 20
      )
    `);
    return true;
  }

  /**
   * Conecta no PostgreSQL e restaura os dados persistidos para o disco local do container.
   */
  async function aplicarMigracoesDados(DADOS_DIR, mapaDocs) {
    const pasta = path.join(DADOS_DIR, 'migracoes');
    if (!fs.existsSync(pasta)) return [];
    const { TIPOS, aplicarOperacoes, serializarComo } = require('./migracoes-dados');
    const arquivos = fs
      .readdirSync(pasta)
      .filter(n => /^[\w.-]+\.json$/.test(n))
      .sort();
    if (!arquivos.length) return [];
    const jaAplicadas = new Set((await pool.query('SELECT id FROM buzu_migracoes')).rows.map(r => r.id));
    const aplicadas = [];
    for (const nomeArq of arquivos) {
      let mig;
      try {
        mig = JSON.parse(fs.readFileSync(path.join(pasta, nomeArq), 'utf8'));
      } catch (err) {
        console.error(`[Banco] Migração ${nomeArq} ilegível: ${err.message}`);
        continue;
      }
      const id = String(mig.id || nomeArq.replace(/\.json$/, ''));
      if (jaAplicadas.has(id)) continue;
      try {
        for (const [nome, ops] of Object.entries(mig.arquivos || {})) {
          const tipo = TIPOS[nome];
          if (!tipo) throw new Error(`arquivo não gerenciado: ${nome}`);
          const caminho = path.join(DADOS_DIR, nome);
          const textoAtual = fs.readFileSync(caminho, 'utf8');
          const novoTexto = serializarComo(textoAtual, aplicarOperacoes(tipo, JSON.parse(textoAtual), ops));
          gravarAtomico(caminho, novoTexto);
          // Se o banco já guardava este arquivo, guarda a versão com a migração aplicada.
          // (Sem cópia no banco, o arquivo do GitHub já é a versão em uso e contém a mudança.)
          const chave = `dados/${nome}`;
          if (mapaDocs.has(chave)) {
            await salvarDocumento(chave, novoTexto, `migracao:${id}`);
            mapaDocs.set(chave, novoTexto);
          }
        }
        await pool.query('INSERT INTO buzu_migracoes (id, descricao) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
          id,
          String(mig.descricao || '').slice(0, 500)
        ]);
        aplicadas.push(id);
        console.log(`[Banco] Migração de dados aplicada: ${id}${mig.descricao ? ` — ${mig.descricao}` : ''}`);
      } catch (err) {
        console.error(`[Banco] Falha ao aplicar a migração ${id}: ${err.message}`);
      }
    }
    return aplicadas;
  }

  async function inicializar({ DADOS_DIR, PASTA_ADMIN, BACKUPS_DIR, ARQ_AUDITORIA }) {
    if (!url) {
      return { ativo: false, motivo: 'DATABASE_URL não definida (usando arquivos locais)' };
    }

    let Pool;
    try {
      ({ Pool } = require('pg'));
    } catch (err) {
      ultimoErro = `Driver pg não instalado: ${err.message}`;
      console.error(`[Banco] ${ultimoErro}`);
      return { ativo: false, erro: ultimoErro };
    }

    try {
      pool = new Pool(montarConfigPg(url));
      pool.on('error', err => {
        console.error('[Banco] Erro inesperado na conexão PostgreSQL:', err.message);
      });
      await pool.query('SELECT 1');
      await criarTabelas();
      conectado = true;
    } catch (err) {
      ultimoErro = err.message;
      console.error(`[Banco] Falha ao conectar ao PostgreSQL (${err.message}). Continuando com arquivos locais.`);
      try {
        await pool?.end();
      } catch (_e) {}
      pool = null;
      conectado = false;
      return { ativo: false, erro: ultimoErro };
    }

    const forcarGit = process.env.BUZU_DB_FORCAR_GIT === '1';
    const restaurados = [];

    try {
      // 1. Restaura documentos salvos no banco (admin + arquivos publicados em dados/)
      const docsRes = await pool.query('SELECT chave, conteudo FROM buzu_documentos');
      const mapaDocs = new Map(docsRes.rows.map(r => [r.chave, r.conteudo]));

      const destinosAdmin = {
        'admin/avisos.json': path.join(PASTA_ADMIN, 'avisos.json'),
        'admin/notas.json': path.join(PASTA_ADMIN, 'notas.json'),
        'admin/estatisticas.json': path.join(PASTA_ADMIN, 'estatisticas.json'),
        'admin/acessos.jsonl': path.join(PASTA_ADMIN, 'acessos.jsonl'),
        'dados/auditoria-admin.jsonl': ARQ_AUDITORIA
      };
      for (const [chave, destino] of Object.entries(destinosAdmin)) {
        if (mapaDocs.has(chave)) {
          gravarAtomico(destino, mapaDocs.get(chave));
          restaurados.push(chave);
        }
      }

      const arquivosDados = [
        'linhas.json',
        'paradas.json',
        'linha_paradas.json',
        'lote-1.geojson',
        'lote-2.geojson'
      ];
      if (!forcarGit) {
        for (const nome of arquivosDados) {
          const chave = `dados/${nome}`;
          if (mapaDocs.has(chave)) {
            gravarAtomico(path.join(DADOS_DIR, nome), mapaDocs.get(chave));
            restaurados.push(chave);
          }
        }
      } else {
        console.log('[Banco] BUZU_DB_FORCAR_GIT=1 ativo: mantendo arquivos dados/ do Git.');
      }

      // 1b. Mudanças de dados feitas no GitHub (dados/migracoes/*.json) entram por cima do que veio
      // do banco, sem apagar o que foi editado no painel. Cada migração roda uma vez só.
      // Com BUZU_DB_FORCAR_GIT=1 o banco não foi restaurado: as migrações ficam para o próximo início normal.
      if (!forcarGit) {
        const aplicadas = await aplicarMigracoesDados(DADOS_DIR, mapaDocs);
        if (aplicadas.length) restaurados.push(`migrações (${aplicadas.join(', ')})`);
      }

      // 2. Restaura ou semeia empresas (tabela relacional buzu_empresas)
      const empRes = await pool.query(
        'SELECT id, nome, sigla, lote, cor, telefone, site, observacao, linhas, criado_por, criado_em, atualizado_por, atualizado_em FROM buzu_empresas ORDER BY nome ASC'
      );
      const arqLinhas = path.join(DADOS_DIR, 'linhas.json');
      if (fs.existsSync(arqLinhas)) {
        const indice = JSON.parse(fs.readFileSync(arqLinhas, 'utf8'));
        if (empRes.rows.length > 0) {
          const empresasBanco = empRes.rows.map(row => ({
            id: row.id,
            nome: row.nome,
            sigla: row.sigla || '',
            lote: row.lote || '',
            cor: row.cor || '#12355B',
            telefone: row.telefone || '',
            site: row.site || '',
            observacao: row.observacao || '',
            criadoPor: row.criado_por || '',
            criadoEm: row.criado_em ? new Date(row.criado_em).toISOString() : '',
            atualizadoPor: row.atualizado_por || '',
            atualizadoEm: row.atualizado_em ? new Date(row.atualizado_em).toISOString() : ''
          }));
          const mapaLinhaParaEmp = new Map();
          for (const row of empRes.rows) {
            const lista = Array.isArray(row.linhas) ? row.linhas : [];
            for (const num of lista) {
              mapaLinhaParaEmp.set(String(num).trim().toUpperCase(), { id: row.id, nome: row.nome });
            }
          }
          indice.empresas = empresasBanco;
          for (const linha of indice.linhas || []) {
            const num = String(linha.numero || linha.id || '').trim().toUpperCase();
            const vinc = mapaLinhaParaEmp.get(num);
            if (vinc) {
              linha.empresa_id = vinc.id;
              linha.empresa = vinc.nome;
            } else if (linha.empresa_id) {
              linha.empresa = null;
              delete linha.empresa_id;
            }
          }
          gravarAtomico(arqLinhas, JSON.stringify(indice, null, 2));
          restaurados.push(`buzu_empresas (${empresasBanco.length})`);
        } else if (Array.isArray(indice.empresas) && indice.empresas.length > 0) {
          await sincronizarTabelaEmpresasDoIndice(indice);
        }
      }

      // 3. Restaura backups (até 20 versões) para dados/backups/
      const bkpRes = await pool.query('SELECT versao, meta, arquivos FROM buzu_backups ORDER BY versao DESC LIMIT 20');
      for (const row of bkpRes.rows) {
        if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(row.versao)) continue;
        const pasta = path.join(BACKUPS_DIR, row.versao);
        if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
        gravarAtomico(path.join(pasta, 'meta.json'), JSON.stringify(row.meta || { versao: row.versao }, null, 2));
        const arqs = row.arquivos && typeof row.arquivos === 'object' ? row.arquivos : {};
        for (const [nomeArq, conteudo] of Object.entries(arqs)) {
          if (arquivosDados.includes(nomeArq) && typeof conteudo === 'string') {
            gravarAtomico(path.join(pasta, nomeArq), conteudo);
          }
        }
      }
      if (bkpRes.rows.length > 0) restaurados.push(`buzu_backups (${bkpRes.rows.length})`);

      console.log(
        `[Banco] PostgreSQL conectado.${restaurados.length ? ` Restaurado: ${restaurados.join(', ')}.` : ' Banco inicializado (pronto para receber dados).'}`
      );
    } catch (err) {
      ultimoErro = err.message;
      console.error('[Banco] Erro ao restaurar dados do PostgreSQL:', err.message);
    }

    return { ativo: true, restaurados };
  }

  async function encerrar() {
    if (pool) {
      try {
        await pool.end();
      } catch (_e) {}
      pool = null;
      conectado = false;
    }
  }

  return {
    inicializar,
    encerrar,
    estaAtivo,
    salvarDocumento,
    anexarLinhaDocumento,
    salvarEmpresa,
    excluirEmpresa,
    sincronizarTabelaEmpresasDoIndice,
    salvarBackup,
    status: () => ({
      configurado: Boolean(url),
      ativo: estaAtivo(),
      ultimoErro: ultimoErro || ''
    })
  };
}

module.exports = { criarBanco, montarConfigPg };
