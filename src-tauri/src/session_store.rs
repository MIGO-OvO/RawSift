use std::{collections::HashMap, fs, path::Path, sync::Mutex};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("无法创建应用数据目录：{0}")]
    CreateDirectory(#[source] std::io::Error),
    #[error("会话数据库操作失败：{0}")]
    Database(#[from] rusqlite::Error),
    #[error("无效的会话标识")]
    InvalidSession,
    #[error("无效的导入模式：{0}")]
    InvalidImportMode(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: String,
    pub source_root: String,
    pub recursive: bool,
    pub active_date: String,
    pub current_capture_id: Option<String>,
    pub destination_root: Option<String>,
    pub shoot_name: String,
    pub import_mode: String,
    pub show_info: bool,
    pub show_histogram: bool,
    pub auto_advance: bool,
    pub reviews: HashMap<String, ReviewStatus>,
    pub transfers: HashMap<String, PersistedTransfer>,
    #[serde(default)]
    pub pending_batch_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReviewStatus {
    Unreviewed,
    Keep,
    Reject,
}

impl ReviewStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unreviewed => "unreviewed",
            Self::Keep => "keep",
            Self::Reject => "reject",
        }
    }

    fn from_db(value: &str) -> Option<Self> {
        match value {
            "unreviewed" => Some(Self::Unreviewed),
            "keep" => Some(Self::Keep),
            "reject" => Some(Self::Reject),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Queued,
    Copying,
    Verifying,
    Verified,
    Committed,
    Failed,
    Cancelled,
}

impl TransferStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Copying => "copying",
            Self::Verifying => "verifying",
            Self::Verified => "verified",
            Self::Committed => "committed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn from_db(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "copying" => Some(Self::Copying),
            "verifying" => Some(Self::Verifying),
            "verified" => Some(Self::Verified),
            "committed" => Some(Self::Committed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTransfer {
    pub status: TransferStatus,
    pub progress: f64,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewUpdate {
    pub session_id: String,
    pub capture_id: String,
    pub status: ReviewStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferUpdate {
    pub session_id: String,
    pub capture_id: String,
    pub transfer: PersistedTransfer,
}

pub struct SessionStore {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatch {
    pub batch_id: String,
    pub session_id: String,
    pub source_root: String,
    pub destination: String,
    pub import_mode: String,
    pub capture_ids: Vec<String>,
    pub files: Vec<crate::ingest::CommittedFile>,
    pub completed_at: String,
}

impl SessionStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(StoreError::CreateDirectory)?;
        }
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self, StoreError> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "busy_timeout", 5_000)?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                source_root TEXT NOT NULL,
                recursive INTEGER NOT NULL,
                active_date TEXT NOT NULL,
                current_capture_id TEXT,
                destination_root TEXT,
                shoot_name TEXT NOT NULL,
                import_mode TEXT NOT NULL,
                show_info INTEGER NOT NULL,
                show_histogram INTEGER NOT NULL,
                auto_advance INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reviews (
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                capture_id TEXT NOT NULL,
                status TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, capture_id)
            );
            CREATE TABLE IF NOT EXISTS transfers (
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                capture_id TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL,
                error TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, capture_id)
            );
            CREATE INDEX IF NOT EXISTS sessions_status_updated
                ON sessions(status, updated_at DESC);
            CREATE TABLE IF NOT EXISTS import_batches (
                batch_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                receipt TEXT NOT NULL,
                completed_at TEXT NOT NULL
            );
            PRAGMA user_version = 2;",
        )?;
        let has_batch_column: bool = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'pending_batch_id'",
            [],
            |row| row.get(0),
        )?;
        if !has_batch_column {
            connection.execute_batch("ALTER TABLE sessions ADD COLUMN pending_batch_id TEXT;")?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn save_session(&self, snapshot: &SessionSnapshot) -> Result<(), StoreError> {
        validate_snapshot(snapshot)?;
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        connection.execute(
            "INSERT INTO sessions (
                session_id, source_root, recursive, active_date, current_capture_id,
                destination_root, shoot_name, import_mode, show_info, show_histogram,
                auto_advance, status, updated_at, pending_batch_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12, ?13)
            ON CONFLICT(session_id) DO UPDATE SET
                source_root = excluded.source_root,
                recursive = excluded.recursive,
                active_date = excluded.active_date,
                current_capture_id = excluded.current_capture_id,
                destination_root = excluded.destination_root,
                shoot_name = excluded.shoot_name,
                import_mode = excluded.import_mode,
                show_info = excluded.show_info,
                show_histogram = excluded.show_histogram,
                auto_advance = excluded.auto_advance,
                updated_at = excluded.updated_at,
                pending_batch_id = CASE WHEN EXISTS (SELECT 1 FROM import_batches WHERE batch_id = excluded.pending_batch_id) THEN sessions.pending_batch_id ELSE excluded.pending_batch_id END",
            params![
                snapshot.session_id,
                snapshot.source_root,
                snapshot.recursive,
                snapshot.active_date,
                snapshot.current_capture_id,
                snapshot.destination_root,
                snapshot.shoot_name,
                snapshot.import_mode,
                snapshot.show_info,
                snapshot.show_histogram,
                snapshot.auto_advance,
                now(),
                snapshot.pending_batch_id,
            ],
        )?;
        Ok(())
    }

    pub fn save_review(&self, update: &ReviewUpdate) -> Result<(), StoreError> {
        validate_session_id(&update.session_id)?;
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        if update.status == ReviewStatus::Unreviewed {
            connection.execute(
                "DELETE FROM reviews WHERE session_id = ?1 AND capture_id = ?2",
                params![update.session_id, update.capture_id],
            )?;
        } else {
            connection.execute(
                "INSERT INTO reviews (session_id, capture_id, status, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_id, capture_id) DO UPDATE SET
                    status = excluded.status, updated_at = excluded.updated_at",
                params![
                    update.session_id,
                    update.capture_id,
                    update.status.as_str(),
                    now(),
                ],
            )?;
        }
        Ok(())
    }

    pub fn save_transfer(&self, update: &TransferUpdate) -> Result<(), StoreError> {
        validate_session_id(&update.session_id)?;
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        connection.execute(
            "INSERT INTO transfers (session_id, capture_id, status, progress, error, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(session_id, capture_id) DO UPDATE SET
                status = excluded.status,
                progress = excluded.progress,
                error = excluded.error,
                updated_at = excluded.updated_at",
            params![
                update.session_id,
                update.capture_id,
                update.transfer.status.as_str(),
                update.transfer.progress,
                update.transfer.error,
                now(),
            ],
        )?;
        Ok(())
    }

    pub fn remove_transfer(&self, session_id: &str, capture_id: &str) -> Result<(), StoreError> {
        validate_session_id(session_id)?;
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        connection.execute(
            "DELETE FROM transfers WHERE session_id = ?1 AND capture_id = ?2",
            params![session_id, capture_id],
        )?;
        Ok(())
    }

    pub fn load_latest_active(&self) -> Result<Option<SessionSnapshot>, StoreError> {
        self.load_active(None)
    }

    pub fn load_latest_for_source(
        &self,
        root: &str,
    ) -> Result<Option<SessionSnapshot>, StoreError> {
        self.load_active(Some(root))
    }

    fn load_active(&self, root: Option<&str>) -> Result<Option<SessionSnapshot>, StoreError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        let mut session = connection
            .query_row(
                "SELECT session_id, source_root, recursive, active_date, current_capture_id,
                        destination_root, shoot_name, import_mode, show_info, show_histogram,
                        auto_advance, pending_batch_id
                 FROM sessions
                 WHERE status = 'active' AND (?1 IS NULL OR source_root = ?1)
                 ORDER BY updated_at DESC
                 LIMIT 1",
                [root],
                |row| {
                    Ok(SessionSnapshot {
                        session_id: row.get(0)?,
                        source_root: row.get(1)?,
                        recursive: row.get(2)?,
                        active_date: row.get(3)?,
                        current_capture_id: row.get(4)?,
                        destination_root: row.get(5)?,
                        shoot_name: row.get(6)?,
                        import_mode: row.get(7)?,
                        show_info: row.get(8)?,
                        show_histogram: row.get(9)?,
                        auto_advance: row.get(10)?,
                        reviews: HashMap::new(),
                        transfers: HashMap::new(),
                        pending_batch_id: row.get(11)?,
                    })
                },
            )
            .optional()?;
        let Some(snapshot) = session.as_mut() else {
            return Ok(None);
        };

        let mut reviews =
            connection.prepare("SELECT capture_id, status FROM reviews WHERE session_id = ?1")?;
        for row in reviews.query_map([&snapshot.session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (capture_id, status) = row?;
            if let Some(status) = ReviewStatus::from_db(&status) {
                snapshot.reviews.insert(capture_id, status);
            }
        }

        let mut transfers = connection.prepare(
            "SELECT capture_id, status, progress, error FROM transfers WHERE session_id = ?1",
        )?;
        for row in transfers.query_map([&snapshot.session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })? {
            let (capture_id, status, progress, error) = row?;
            if let Some(status) = TransferStatus::from_db(&status) {
                snapshot.transfers.insert(
                    capture_id,
                    PersistedTransfer {
                        status,
                        progress,
                        error,
                    },
                );
            }
        }
        Ok(session)
    }

    #[cfg(test)]
    pub fn mark_committed(&self, session_id: &str) -> Result<(), StoreError> {
        validate_session_id(session_id)?;
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        connection.execute(
            "UPDATE sessions SET status = 'committed', updated_at = ?2 WHERE session_id = ?1",
            params![session_id, now()],
        )?;
        Ok(())
    }

    pub fn save_import_batch(&self, batch: &ImportBatch) -> Result<(), StoreError> {
        validate_session_id(&batch.batch_id)?;
        validate_session_id(&batch.session_id)?;
        let receipt = serde_json::to_string(batch).expect("serializable receipt");
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        let transaction = connection.transaction()?;
        transaction.execute("INSERT INTO import_batches(batch_id, session_id, receipt, completed_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(batch_id) DO UPDATE SET receipt = excluded.receipt", params![batch.batch_id, batch.session_id, receipt, batch.completed_at])?;
        for id in &batch.capture_ids {
            transaction.execute("INSERT INTO transfers(session_id, capture_id, status, progress, error, updated_at) VALUES (?1, ?2, 'committed', 1, NULL, ?3) ON CONFLICT(session_id, capture_id) DO UPDATE SET status = 'committed', progress = 1, error = NULL, updated_at = excluded.updated_at", params![batch.session_id, id, now()])?;
        }
        transaction.execute(
            "UPDATE sessions SET pending_batch_id = ?2, updated_at = ?3 WHERE session_id = ?1",
            params![batch.session_id, Uuid::new_v4().to_string(), now()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn load_import_batch(&self, id: &str) -> Result<Option<ImportBatch>, StoreError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        let json: Option<String> = connection
            .query_row(
                "SELECT receipt FROM import_batches WHERE batch_id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|value| {
            serde_json::from_str(&value).map_err(|e| {
                StoreError::Database(rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                ))
            })
        })
        .transpose()
    }

    pub fn load_import_history(&self) -> Result<Vec<ImportBatch>, StoreError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        let mut statement = connection
            .prepare("SELECT receipt FROM import_batches ORDER BY completed_at DESC LIMIT 100")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut batches = Vec::new();
        for row in rows {
            let json = row?;
            let batch = serde_json::from_str(&json).map_err(|e| {
                StoreError::Database(rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                ))
            })?;
            batches.push(batch);
        }
        Ok(batches)
    }
}

fn validate_snapshot(snapshot: &SessionSnapshot) -> Result<(), StoreError> {
    validate_session_id(&snapshot.session_id)?;
    if let Some(batch) = &snapshot.pending_batch_id {
        validate_session_id(batch)?;
    }
    if !matches!(snapshot.import_mode.as_str(), "jpeg" | "raw" | "jpeg+raw") {
        return Err(StoreError::InvalidImportMode(snapshot.import_mode.clone()));
    }
    Ok(())
}

fn validate_session_id(value: &str) -> Result<(), StoreError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| StoreError::InvalidSession)
}

fn now() -> i64 {
    Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SessionStore {
        SessionStore::from_connection(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn snapshot() -> SessionSnapshot {
        SessionSnapshot {
            session_id: Uuid::new_v4().to_string(),
            source_root: r"D:\DCIM".to_owned(),
            recursive: true,
            active_date: "2026-09-04".to_owned(),
            current_capture_id: Some("capture-1".to_owned()),
            destination_root: Some(r"D:\Photos".to_owned()),
            shoot_name: "街拍".to_owned(),
            import_mode: "raw".to_owned(),
            show_info: true,
            show_histogram: true,
            auto_advance: true,
            reviews: HashMap::new(),
            transfers: HashMap::new(),
            pending_batch_id: None,
        }
    }

    #[test]
    fn batches_preserve_active_review_and_atomic_completed_capture_records() {
        let store = store();
        let session = snapshot();
        store.save_session(&session).unwrap();
        for id in ["photo-a", "photo-b"] {
            let batch = ImportBatch {
                batch_id: Uuid::new_v4().to_string(),
                session_id: session.session_id.clone(),
                source_root: session.source_root.clone(),
                destination: "F:/Photos".to_owned(),
                import_mode: "raw".to_owned(),
                capture_ids: vec![id.to_owned()],
                files: Vec::new(),
                completed_at: Utc::now().to_rfc3339(),
            };
            store.save_import_batch(&batch).unwrap();
            store.save_import_batch(&batch).unwrap(); // same receipt is idempotent
        }
        let active = store.load_latest_active().unwrap().unwrap();
        assert_eq!(active.session_id, session.session_id);
        assert_eq!(
            active.transfers["photo-a"].status,
            TransferStatus::Committed
        );
        assert_eq!(
            active.transfers["photo-b"].status,
            TransferStatus::Committed
        );
        assert_eq!(store.load_import_history().unwrap().len(), 2);
        let other = SessionSnapshot {
            session_id: Uuid::new_v4().to_string(),
            source_root: "G:/DCIM".to_owned(),
            ..snapshot()
        };
        store.save_session(&other).unwrap();
        assert_eq!(
            store
                .load_latest_for_source(&session.source_root)
                .unwrap()
                .unwrap()
                .session_id,
            session.session_id
        );
        assert_eq!(store.load_import_history().unwrap().len(), 2);
    }

    #[test]
    fn round_trips_active_session_reviews_and_transfers() {
        let store = store();
        let expected = snapshot();
        store.save_session(&expected).unwrap();
        store
            .save_review(&ReviewUpdate {
                session_id: expected.session_id.clone(),
                capture_id: "capture-1".to_owned(),
                status: ReviewStatus::Keep,
            })
            .unwrap();
        store
            .save_transfer(&TransferUpdate {
                session_id: expected.session_id.clone(),
                capture_id: "capture-1".to_owned(),
                transfer: PersistedTransfer {
                    status: TransferStatus::Verified,
                    progress: 1.0,
                    error: None,
                },
            })
            .unwrap();

        let loaded = store.load_latest_active().unwrap().unwrap();

        assert_eq!(loaded.session_id, expected.session_id);
        assert_eq!(loaded.reviews["capture-1"], ReviewStatus::Keep);
        assert_eq!(
            loaded.transfers["capture-1"].status,
            TransferStatus::Verified
        );
    }

    #[test]
    fn committed_session_is_not_resumed() {
        let store = store();
        let expected = snapshot();
        store.save_session(&expected).unwrap();
        store.mark_committed(&expected.session_id).unwrap();

        assert!(store.load_latest_active().unwrap().is_none());
    }

    #[test]
    fn clearing_review_removes_its_row() {
        let store = store();
        let expected = snapshot();
        store.save_session(&expected).unwrap();
        store
            .save_review(&ReviewUpdate {
                session_id: expected.session_id.clone(),
                capture_id: "capture-1".to_owned(),
                status: ReviewStatus::Keep,
            })
            .unwrap();
        store
            .save_review(&ReviewUpdate {
                session_id: expected.session_id,
                capture_id: "capture-1".to_owned(),
                status: ReviewStatus::Unreviewed,
            })
            .unwrap();

        assert!(
            store
                .load_latest_active()
                .unwrap()
                .unwrap()
                .reviews
                .is_empty()
        );
    }
}
