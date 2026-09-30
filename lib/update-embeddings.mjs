// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview embeddingを生成し、documents / chaptersのembeddingカラムをUPDATEする。
 *
 * データ投入とembedding生成を分離するためのモジュール。
 * `sync`からは同一プロセスで、単体では`update-embeddings`サブコマンドで実行する。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs update-embeddings            # 未処理レコードのみ処理
 * knowledge-base.mjs update-embeddings --limit 50 # 最大50件だけ処理(テスト用)
 * ```
 *
 * 特徴:
 * - 既定: WHERE embedding IS NULL で未処理レコードのみ対象
 * - 文書のembeddingは章から独立して生成し、summaryが空の場合はcontentを使う
 * - 全UPDATEを1つのSQLにまとめてバッチ書き込み(1件ずつのDBロック競合を回避)
 * - 途中で止めても再実行で続きから再開可能
 */

import { ensureDependencies } from './ensure-deps.mjs';
import { getEmbedding } from './embed.mjs';
import { query, exec } from './db.mjs';

/**
 * メイン処理。
 *
 * embedding未生成のchapters / documentsを対象にembeddingを生成し、
 * バッチUPDATEでDBに反映する。
 */
export async function run(rest = [], { limit: limitOverride = null } = {}) {
  await ensureDependencies();

  const limit = limitOverride !== null
    ? Math.min(Math.max(limitOverride, 0), 10000)
    : Math.min(Math.max(parseInt(argv.limit || argv.l || 0, 10) || 0, 0), 10000);

  // 文書レベルのembedding: 章の有無に依存せず、未生成の文書を対象にする
  let docSql = `SELECT id, file_path, summary, content FROM documents WHERE embedding IS NULL ORDER BY id`;
  if (limit > 0) docSql += ` LIMIT ${limit}`;
  const docRows = await query(docSql);

  // embedding 未生成の chapters を取得
  let sql = `SELECT c.id, c.document_id, c.heading, c.summary, d.file_path
    FROM chapters c JOIN documents d ON d.id = c.document_id
    WHERE c.embedding IS NULL
    ORDER BY c.id`;
  if (limit > 0) sql += ` LIMIT ${limit}`;
  const rows = await query(sql);

  if (docRows.length === 0 && rows.length === 0) {
    echo(chalk.green('\n✅ すべてのドキュメントとチャプターに embedding が生成されています\n'));
    return;
  }

  // embedding生成 → バッチSQLを構築
  const batchStmts = [];

  // 文書全体のembedding: summary(見出しtree)をベクトル化し、空の場合は本文を使う
  if (docRows.length > 0) {
    echo(chalk.bold(`\n🧠 文書の embedding 生成: ${docRows.length} 件\n`));

    for (let i = 0; i < docRows.length; i++) {
      const d = docRows[i];
      const input = d.summary || d.content || '';
      if (!input) {
        echo(chalk.yellow(`  ⚠ 入力が空のためスキップ: ${d.file_path}`));
        continue;
      }

      echo(chalk.gray(`  [${i + 1}/${docRows.length}] ${d.file_path}`));

      const docEmb = await getEmbedding(input, 'passage');
      if (docEmb) {
        const es = `[${docEmb.join(',')}]`;
        batchStmts.push(`UPDATE documents SET embedding = ${es}::FLOAT[384] WHERE id = ${d.id};\n`);
      }
    }
  }

  // 章のembedding
  if (rows.length > 0) {
    echo(chalk.bold(`\n🧠 章の embedding 生成: ${rows.length} 件\n`));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      echo(chalk.gray(`  [${i + 1}/${rows.length}] ${r.file_path} > ${r.heading || '(見出しなし)'}`));

      // 章のembedding: chapters.summary(擬似要約)をベクトル化
      const emb = await getEmbedding(r.summary || '', 'passage');

      if (emb) {
        const es = `[${emb.join(',')}]`;
        batchStmts.push(`UPDATE chapters SET embedding = ${es}::FLOAT[384] WHERE id = ${r.id};\n`);
      }

      // 進捗表示
      if ((i + 1) % 10 === 0 || i === rows.length - 1) {
        echo(chalk.gray(`  進捗: ${i + 1}/${rows.length}`));
      }
    }
  }

  if (batchStmts.length === 0) {
    echo(chalk.yellow('\n⚠ 更新対象がありませんでした\n'));
    return;
  }

  // 全UPDATEを単一の exec で実行(単一コネクション内で効率的に処理)
  echo(chalk.cyan('\n💾 バッチ書き込み中...'));
  await exec(batchStmts.join(''));
  echo(chalk.green(`✅ ${batchStmts.length}件のUPDATEを完了しました\n`));
}
