/*
** sqlite-engine: SQLite 3.53.2 (the amalgamation bundled by libsqlite3-sys 0.38.2, as
** moonrun links it) for moonrun-js. Built by scripts/build-sqlite.ts with the
** wasi-sysroot libc and no WASI imports: the OS layer below reaches the host only
** through the `host.*` imports declared here, which src/domains/sqlite/vfs.ts provides.
**
** The VFS is a cut-down port of SQLite's own os_unix.c (unixOpen, unixRead, ...,
** unixFullPathname, unixGetTempname, unixDelete, unixAccess), so the files SQLite
** creates, their names and the result codes match moonrun's default "unix" VFS. Locks
** go to the host's in-process lock table (unixLock's inode logic) and only the main
** database file takes them, as with unix's nolock methods for journals.
**
** Host imports return a value >= 0 on success and a negated Linux errno on failure.
*/
#include "sqlite3.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

#define IMPORT(name) __attribute__((import_module("host"), import_name(name)))
#define EXPORT(name) __attribute__((export_name(name)))

#define H_ENOENT 2
#define H_EINTR 4
#define H_EIO 5
#define H_ENXIO 6
#define H_EACCES 13
#define H_EISDIR 21
#define H_ENOSPC 28
#define H_ERANGE 34

/* open(2) as unixOpen builds it: O_RDONLY/O_RDWR, O_CREAT, O_EXCL; always O_NOFOLLOW. */
#define H_OPEN_READWRITE 1
#define H_OPEN_CREATE 2
#define H_OPEN_EXCLUSIVE 4

IMPORT("open") int h_open(const char *path, int flags, int mode);
IMPORT("close") int h_close(int fd);
IMPORT("pread") int h_pread(int fd, void *buf, int n, sqlite3_int64 offset);
IMPORT("pwrite") int h_pwrite(int fd, const void *buf, int n, sqlite3_int64 offset);
IMPORT("ftruncate") int h_ftruncate(int fd, sqlite3_int64 size);
IMPORT("fsync") int h_fsync(int fd);
IMPORT("fsize") sqlite3_int64 h_fsize(int fd);
/* stat(2): 1 regular file, 2 directory, 3 other; `size` receives st_size. */
IMPORT("stat") int h_stat(const char *path, sqlite3_int64 *size);
/* st_mode & 0777 of stat(2). */
IMPORT("file_mode") int h_file_mode(const char *path);
/* lstat(2): 1 for a symbolic link, 0 otherwise. */
IMPORT("lstat_is_link") int h_lstat_is_link(const char *path);
IMPORT("readlink") int h_readlink(const char *path, char *buf, int n);
/* access(2) with R_OK=4, W_OK=2, X_OK=1, F_OK=0. */
IMPORT("access") int h_access(const char *path, int mode);
IMPORT("unlink") int h_unlink(const char *path);
/* Writes the working directory (no NUL) and returns its length. */
IMPORT("getcwd") int h_getcwd(char *buf, int n);
/* Writes the variable's value (no NUL) and returns its length; -1 when unset. */
IMPORT("getenv") int h_getenv(const char *name, char *buf, int n);
/* The in-process lock table (unixLock / posixUnlock / unixCheckReservedLock). */
IMPORT("lock") int h_lock(int fd, int level);
IMPORT("unlock") int h_unlock(int fd, int level);
IMPORT("check_reserved") int h_check_reserved(int fd);
IMPORT("random") void h_random(void *buf, int n);
IMPORT("now_ms") sqlite3_int64 h_now_ms(void);
/* Seconds east of UTC of the host's local time zone at `unix_seconds`. */
IMPORT("utc_offset") int h_utc_offset(sqlite3_int64 unix_seconds);
IMPORT("sleep_us") void h_sleep_us(int microseconds);
/* The SQL policy (moonrun sqlite/policy.rs `untrusted_authorizer`). */
IMPORT("authorize")
int h_authorize(int action, const char *a1, const char *a2, const char *db, const char *trigger);
/* Called every PROGRESS_OPS VM steps of a Job; may suspend this engine call (JSPI). */
IMPORT("progress") int h_progress(void);

#define MAX_PATHNAME 512
#define MAX_PATHLEN 4096 /* glibc FILENAME_MAX, SQLite's SQLITE_MAX_PATHLEN */
#define MAX_SYMLINK 200
#define DEFAULT_FILE_PERMISSIONS 0644
#define DEFAULT_SECTOR_SIZE 4096
#define TEMP_FILE_PREFIX "etilqs_"
#define PROGRESS_OPS 1000

/* ------------------------------------------------------------------------- */
/* Files                                                                      */

typedef struct HostFile {
  sqlite3_file base;
  int fd;
  int lock;    /* NO_LOCK .. EXCLUSIVE_LOCK held through this handle */
  int noLock;  /* not the main database: locking is ignored (unix nolock methods) */
} HostFile;

static int hostClose(sqlite3_file *id) {
  HostFile *p = (HostFile *)id;
  if (!p->noLock && p->lock != SQLITE_LOCK_NONE) {
    h_unlock(p->fd, SQLITE_LOCK_NONE);
  }
  h_close(p->fd);
  p->fd = -1;
  return SQLITE_OK;
}

/* seekAndRead: retries EINTR and partial reads; returns bytes read or -errno. */
static int hostSeekAndRead(HostFile *p, sqlite3_int64 offset, void *buf, int cnt) {
  int got;
  int prior = 0;
  do {
    got = h_pread(p->fd, buf, cnt, offset);
    if (got == cnt) break;
    if (got < 0) {
      if (got == -H_EINTR) {
        got = 1;
        continue;
      }
      return got;
    } else if (got > 0) {
      cnt -= got;
      offset += got;
      prior += got;
      buf = (char *)buf + got;
    }
  } while (got > 0);
  return got + prior;
}

static int hostRead(sqlite3_file *id, void *buf, int amt, sqlite3_int64 offset) {
  HostFile *p = (HostFile *)id;
  int got = hostSeekAndRead(p, offset, buf, amt);
  if (got == amt) return SQLITE_OK;
  if (got < 0) {
    switch (-got) {
      case H_ERANGE:
      case H_EIO:
      case H_ENXIO:
        return SQLITE_IOERR_CORRUPTFS;
    }
    return SQLITE_IOERR_READ;
  }
  memset((char *)buf + got, 0, amt - got);
  return SQLITE_IOERR_SHORT_READ;
}

static int hostSeekAndWrite(HostFile *p, sqlite3_int64 offset, const void *buf, int n) {
  int rc;
  do {
    rc = h_pwrite(p->fd, buf, n, offset);
  } while (rc == -H_EINTR);
  return rc;
}

static int hostWrite(sqlite3_file *id, const void *buf, int amt, sqlite3_int64 offset) {
  HostFile *p = (HostFile *)id;
  int wrote;
  while ((wrote = hostSeekAndWrite(p, offset, buf, amt)) < amt && wrote > 0) {
    amt -= wrote;
    offset += wrote;
    buf = (const char *)buf + wrote;
  }
  if (amt > wrote) {
    if (wrote < 0 && wrote != -H_ENOSPC) return SQLITE_IOERR_WRITE;
    return SQLITE_FULL;
  }
  return SQLITE_OK;
}

static int hostTruncate(sqlite3_file *id, sqlite3_int64 size) {
  return h_ftruncate(((HostFile *)id)->fd, size) < 0 ? SQLITE_IOERR_TRUNCATE : SQLITE_OK;
}

/* unixSync without the directory fsync() after creating a journal. */
static int hostSync(sqlite3_file *id, int flags) {
  (void)flags;
  return h_fsync(((HostFile *)id)->fd) < 0 ? SQLITE_IOERR_FSYNC : SQLITE_OK;
}

static int hostFileSize(sqlite3_file *id, sqlite3_int64 *size) {
  sqlite3_int64 n = h_fsize(((HostFile *)id)->fd);
  if (n < 0) return SQLITE_IOERR_FSTAT;
  *size = n == 1 ? 0 : n;
  return SQLITE_OK;
}

static int hostLock(sqlite3_file *id, int level) {
  HostFile *p = (HostFile *)id;
  int rc;
  if (p->noLock) return SQLITE_OK;
  rc = h_lock(p->fd, level);
  if (rc == SQLITE_OK) p->lock = level;
  return rc;
}

static int hostUnlock(sqlite3_file *id, int level) {
  HostFile *p = (HostFile *)id;
  int rc;
  if (p->noLock) return SQLITE_OK;
  rc = h_unlock(p->fd, level);
  if (rc == SQLITE_OK) p->lock = level;
  return rc;
}

static int hostCheckReservedLock(sqlite3_file *id, int *out) {
  HostFile *p = (HostFile *)id;
  *out = p->noLock ? 0 : h_check_reserved(p->fd);
  return SQLITE_OK;
}

static int hostFileControl(sqlite3_file *id, int op, void *arg) {
  (void)id;
  (void)op;
  (void)arg;
  return SQLITE_NOTFOUND;
}

static int hostSectorSize(sqlite3_file *id) {
  (void)id;
  return DEFAULT_SECTOR_SIZE;
}

/* Linux setDeviceCharacteristics with the default `psow` (SQLITE_POWERSAFE_OVERWRITE=1). */
static int hostDeviceCharacteristics(sqlite3_file *id) {
  (void)id;
  return SQLITE_IOCAP_POWERSAFE_OVERWRITE | SQLITE_IOCAP_SUBPAGE_READ;
}

static const sqlite3_io_methods hostIoMethods = {
    1,
    hostClose,
    hostRead,
    hostWrite,
    hostTruncate,
    hostSync,
    hostFileSize,
    hostLock,
    hostUnlock,
    hostCheckReservedLock,
    hostFileControl,
    hostSectorSize,
    hostDeviceCharacteristics,
};

/* ------------------------------------------------------------------------- */
/* The VFS                                                                    */

static int hostStat(const char *path, int *kind, sqlite3_int64 *size) {
  int k = h_stat(path, size);
  if (k < 0) return k;
  *kind = k;
  return 0;
}

/* unixTempFileDir: SQLITE_TMPDIR, TMPDIR, /var/tmp, /usr/tmp, /tmp, "." */
static const char *hostTempFileDir(char *env, int nEnv) {
  static const char *azFixed[] = {"/var/tmp", "/usr/tmp", "/tmp", "."};
  static const char *azEnv[] = {"SQLITE_TMPDIR", "TMPDIR"};
  int kind;
  sqlite3_int64 size;
  for (int i = 0; i < 2; i++) {
    int n = h_getenv(azEnv[i], env, nEnv - 1);
    if (n < 0 || n >= nEnv) continue;
    env[n] = 0;
    if (hostStat(env, &kind, &size) == 0 && kind == 2 && h_access(env, 3) == 0) return env;
  }
  for (unsigned i = 0; i < sizeof(azFixed) / sizeof(azFixed[0]); i++) {
    if (hostStat(azFixed[i], &kind, &size) == 0 && kind == 2 && h_access(azFixed[i], 3) == 0) {
      return azFixed[i];
    }
  }
  return 0;
}

/* unixGetTempname */
static int hostGetTempname(int nBuf, char *zBuf) {
  char env[MAX_PATHNAME + 2];
  const char *zDir;
  int iLimit = 0;
  int rc = SQLITE_OK;
  zBuf[0] = 0;
  sqlite3_mutex_enter(sqlite3_mutex_alloc(SQLITE_MUTEX_STATIC_VFS1));
  zDir = hostTempFileDir(env, sizeof(env));
  if (zDir == 0) {
    rc = SQLITE_IOERR_GETTEMPPATH;
  } else {
    do {
      sqlite3_uint64 r;
      sqlite3_randomness(sizeof(r), &r);
      zBuf[nBuf - 2] = 0;
      sqlite3_snprintf(nBuf, zBuf, "%s/" TEMP_FILE_PREFIX "%llx%c", zDir, r, 0);
      if (zBuf[nBuf - 2] != 0 || (iLimit++) > 10) {
        rc = SQLITE_ERROR;
        break;
      }
    } while (h_access(zBuf, 0) == 0);
  }
  sqlite3_mutex_leave(sqlite3_mutex_alloc(SQLITE_MUTEX_STATIC_VFS1));
  return rc;
}

/* findCreateFileMode: journals and WAL files take the database file's permissions. */
static int hostCreateFileMode(const char *zPath, int flags, int *pMode) {
  *pMode = 0;
  if (flags & (SQLITE_OPEN_WAL | SQLITE_OPEN_MAIN_JOURNAL)) {
    char zDb[MAX_PATHNAME + 1];
    int nDb = (int)strlen(zPath) - 1;
    while (nDb > 0 && zPath[nDb] != '.') {
      if (zPath[nDb] == '-') {
        int mode;
        memcpy(zDb, zPath, nDb);
        zDb[nDb] = '\0';
        mode = h_file_mode(zDb);
        if (mode < 0) return SQLITE_IOERR_FSTAT;
        *pMode = mode;
        break;
      }
      nDb--;
    }
  } else if (flags & SQLITE_OPEN_DELETEONCLOSE) {
    *pMode = 0600;
  } else if (flags & SQLITE_OPEN_URI) {
    const char *z = sqlite3_uri_parameter(zPath, "modeof");
    if (z) {
      int mode = h_file_mode(z);
      if (mode < 0) return SQLITE_IOERR_FSTAT;
      *pMode = mode;
    }
  }
  return SQLITE_OK;
}

static int hostRobustOpen(const char *z, int flags, int mode) {
  int fd;
  do {
    fd = h_open(z, flags, mode ? mode : DEFAULT_FILE_PERMISSIONS);
  } while (fd == -H_EINTR);
  return fd;
}

/* unixOpen */
static int hostOpen(sqlite3_vfs *vfs, const char *zPath, sqlite3_file *file, int flags,
                    int *pOutFlags) {
  HostFile *p = (HostFile *)file;
  int fd;
  int openFlags = 0;
  int eType = flags & 0x0FFF00;
  int rc = SQLITE_OK;
  int openMode;
  int isExclusive = flags & SQLITE_OPEN_EXCLUSIVE;
  int isDelete = flags & SQLITE_OPEN_DELETEONCLOSE;
  int isCreate = flags & SQLITE_OPEN_CREATE;
  int isReadWrite = flags & SQLITE_OPEN_READWRITE;
  int isNewJrnl = isCreate && (eType == SQLITE_OPEN_SUPER_JOURNAL ||
                               eType == SQLITE_OPEN_MAIN_JOURNAL || eType == SQLITE_OPEN_WAL);
  char zTmpname[MAX_PATHNAME + 2];
  const char *zName = zPath;

  memset(p, 0, sizeof(*p));
  p->fd = -1;
  if (!zName) {
    rc = hostGetTempname(vfs->mxPathname, zTmpname);
    if (rc != SQLITE_OK) return rc;
    zName = zTmpname;
  }
  if (isReadWrite) openFlags |= H_OPEN_READWRITE;
  if (isCreate) openFlags |= H_OPEN_CREATE;
  if (isExclusive) openFlags |= H_OPEN_EXCLUSIVE;

  rc = hostCreateFileMode(zName, flags, &openMode);
  if (rc != SQLITE_OK) return rc;
  fd = hostRobustOpen(zName, openFlags, openMode);
  if (fd < 0) {
    if (isNewJrnl && fd == -H_EACCES && h_access(zName, 0) != 0) {
      rc = SQLITE_READONLY_DIRECTORY;
    } else if (fd != -H_EISDIR && isReadWrite) {
      /* Failed to open the file for read/write access. Try read-only. */
      flags &= ~(SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
      flags |= SQLITE_OPEN_READONLY;
      openFlags &= ~(H_OPEN_READWRITE | H_OPEN_CREATE);
      fd = hostRobustOpen(zName, openFlags, openMode);
    }
  }
  if (fd < 0) {
    return rc == SQLITE_OK ? SQLITE_CANTOPEN : rc;
  }
  if (pOutFlags) *pOutFlags = flags;
  if (isDelete) h_unlink(zName);
  p->fd = fd;
  p->noLock = eType != SQLITE_OPEN_MAIN_DB;
  p->base.pMethods = &hostIoMethods;
  return SQLITE_OK;
}

/* unixDelete (the directory is not fsync()ed afterwards) */
static int hostDelete(sqlite3_vfs *vfs, const char *zPath, int dirSync) {
  int rc;
  (void)vfs;
  (void)dirSync;
  rc = h_unlink(zPath);
  if (rc < 0) return rc == -H_ENOENT ? SQLITE_IOERR_DELETE_NOENT : SQLITE_IOERR_DELETE;
  return SQLITE_OK;
}

/* unixAccess */
static int hostAccess(sqlite3_vfs *vfs, const char *zPath, int flags, int *pResOut) {
  (void)vfs;
  if (flags == SQLITE_ACCESS_EXISTS) {
    int kind;
    sqlite3_int64 size;
    *pResOut = hostStat(zPath, &kind, &size) == 0 && (kind != 1 || size > 0);
  } else {
    *pResOut = h_access(zPath, 2 | 4) == 0;
  }
  return SQLITE_OK;
}

/* unixFullPathname: makes the path absolute, drops "." and "..", resolves symlinks. */
typedef struct DbPath {
  int rc;
  int nSymlink;
  char *zOut;
  int nOut;
  int nUsed;
} DbPath;

static void appendAllPathElements(DbPath *, const char *);

static void appendOnePathElement(DbPath *pPath, const char *zName, int nName) {
  if (zName[0] == '.') {
    if (nName == 1) return;
    if (zName[1] == '.' && nName == 2) {
      if (pPath->nUsed > 1) {
        while (pPath->zOut[--pPath->nUsed] != '/') {
        }
      }
      return;
    }
  }
  if (pPath->nUsed + nName + 2 >= pPath->nOut) {
    pPath->rc = SQLITE_ERROR;
    return;
  }
  pPath->zOut[pPath->nUsed++] = '/';
  memcpy(&pPath->zOut[pPath->nUsed], zName, nName);
  pPath->nUsed += nName;
  if (pPath->rc == SQLITE_OK) {
    const char *zIn;
    int isLink;
    pPath->zOut[pPath->nUsed] = 0;
    zIn = pPath->zOut;
    isLink = h_lstat_is_link(zIn);
    if (isLink < 0) {
      if (isLink != -H_ENOENT) pPath->rc = SQLITE_CANTOPEN;
    } else if (isLink) {
      int got;
      char zLnk[MAX_PATHLEN + 2];
      if (pPath->nSymlink++ > MAX_SYMLINK) {
        pPath->rc = SQLITE_CANTOPEN;
        return;
      }
      got = h_readlink(zIn, zLnk, sizeof(zLnk) - 2);
      if (got <= 0 || got >= (int)sizeof(zLnk) - 2) {
        pPath->rc = SQLITE_CANTOPEN;
        return;
      }
      zLnk[got] = 0;
      if (zLnk[0] == '/') {
        pPath->nUsed = 0;
      } else {
        pPath->nUsed -= nName + 1;
      }
      appendAllPathElements(pPath, zLnk);
    }
  }
}

static void appendAllPathElements(DbPath *pPath, const char *zPath) {
  int i = 0;
  int j = 0;
  do {
    while (zPath[i] && zPath[i] != '/') i++;
    if (i > j) appendOnePathElement(pPath, &zPath[j], i - j);
    j = i + 1;
  } while (zPath[i++]);
}

static int hostFullPathname(sqlite3_vfs *vfs, const char *zPath, int nOut, char *zOut) {
  DbPath path;
  (void)vfs;
  path.rc = 0;
  path.nUsed = 0;
  path.nSymlink = 0;
  path.nOut = nOut;
  path.zOut = zOut;
  if (zPath[0] != '/') {
    char zPwd[MAX_PATHLEN + 2];
    int n = h_getcwd(zPwd, sizeof(zPwd) - 2);
    if (n < 0) return SQLITE_CANTOPEN;
    zPwd[n] = 0;
    appendAllPathElements(&path, zPwd);
  }
  appendAllPathElements(&path, zPath);
  zOut[path.nUsed] = 0;
  if (path.rc || path.nUsed < 2) return SQLITE_CANTOPEN;
  if (path.nSymlink) return SQLITE_OK_SYMLINK;
  return SQLITE_OK;
}

/* Extensions cannot be loaded: there is no dynamic linker. */
static void *hostDlOpen(sqlite3_vfs *vfs, const char *zFilename) {
  (void)vfs;
  (void)zFilename;
  return 0;
}
static void hostDlError(sqlite3_vfs *vfs, int nBuf, char *zBufOut) {
  (void)vfs;
  sqlite3_snprintf(nBuf, zBufOut, "dynamic libraries are not supported");
}
static void (*hostDlSym(sqlite3_vfs *vfs, void *p, const char *zSym))(void) {
  (void)vfs;
  (void)p;
  (void)zSym;
  return 0;
}
static void hostDlClose(sqlite3_vfs *vfs, void *handle) {
  (void)vfs;
  (void)handle;
}

static int hostRandomness(sqlite3_vfs *vfs, int nBuf, char *zBuf) {
  (void)vfs;
  memset(zBuf, 0, nBuf);
  h_random(zBuf, nBuf);
  return nBuf;
}

static int hostSleep(sqlite3_vfs *vfs, int microseconds) {
  (void)vfs;
  h_sleep_us(microseconds);
  return microseconds;
}

/* unixCurrentTimeInt64: Julian day number times 86400000. */
static int hostCurrentTimeInt64(sqlite3_vfs *vfs, sqlite3_int64 *piNow) {
  static const sqlite3_int64 unixEpoch = 24405875 * (sqlite3_int64)8640000;
  (void)vfs;
  *piNow = unixEpoch + h_now_ms();
  return SQLITE_OK;
}

static int hostCurrentTime(sqlite3_vfs *vfs, double *prNow) {
  sqlite3_int64 i = 0;
  int rc = hostCurrentTimeInt64(vfs, &i);
  *prNow = i / 86400000.0;
  return rc;
}

static int hostGetLastError(sqlite3_vfs *vfs, int nBuf, char *zBuf) {
  (void)vfs;
  (void)nBuf;
  (void)zBuf;
  return 0;
}

int sqlite3_os_init(void) {
  static sqlite3_vfs vfs = {
      2,                /* iVersion */
      sizeof(HostFile), /* szOsFile */
      MAX_PATHNAME,     /* mxPathname */
      0,                /* pNext */
      "unix",           /* zName */
      0,                /* pAppData */
      hostOpen,
      hostDelete,
      hostAccess,
      hostFullPathname,
      hostDlOpen,
      hostDlError,
      hostDlSym,
      hostDlClose,
      hostRandomness,
      hostSleep,
      hostCurrentTime,
      hostGetLastError,
      hostCurrentTimeInt64,
  };
  return sqlite3_vfs_register(&vfs, 1);
}

int sqlite3_os_end(void) { return SQLITE_OK; }

/* SQLite's osLocaltime (HAVE_LOCALTIME_R) in the host's time zone. */
struct tm *localtime_r(const time_t *t, struct tm *out) {
  time_t local = *t + h_utc_offset((sqlite3_int64)*t);
  return gmtime_r(&local, out);
}

/* ------------------------------------------------------------------------- */
/* Mutexes (SQLITE_MUTEX_APPDEF)                                              */
/*
** One thread runs this engine, so a mutex only counts its entries: with
** SQLITE_THREADSAFE=1 and SQLITE_OPEN_FULLMUTEX every connection still has a
** (non-NULL) recursive mutex, as sqlite3_db_mutex reports in moonrun. Exclusion
** between the guest and Jobs is the host's (src/domains/sqlite/host.ts).
*/
struct sqlite3_mutex {
  int id;
  int count;
};

static struct sqlite3_mutex staticMutexes[SQLITE_MUTEX_STATIC_VFS3 + 1];

static int mutexInit(void) { return SQLITE_OK; }
static int mutexEnd(void) { return SQLITE_OK; }
static sqlite3_mutex *mutexAlloc(int id) {
  if (id == SQLITE_MUTEX_FAST || id == SQLITE_MUTEX_RECURSIVE) {
    sqlite3_mutex *m = malloc(sizeof(*m));
    if (m) {
      m->id = id;
      m->count = 0;
    }
    return m;
  }
  if (id < 0 || id > SQLITE_MUTEX_STATIC_VFS3) return 0;
  staticMutexes[id].id = id;
  return &staticMutexes[id];
}
static void mutexFree(sqlite3_mutex *m) {
  if (m->id == SQLITE_MUTEX_FAST || m->id == SQLITE_MUTEX_RECURSIVE) free(m);
}
static void mutexEnter(sqlite3_mutex *m) { m->count++; }
static int mutexTry(sqlite3_mutex *m) {
  m->count++;
  return SQLITE_OK;
}
static void mutexLeave(sqlite3_mutex *m) { m->count--; }

static sqlite3_mutex_methods mutexMethods = {
    mutexInit, mutexEnd, mutexAlloc, mutexFree, mutexEnter, mutexTry, mutexLeave, 0, 0,
};

sqlite3_mutex_methods const *sqlite3DefaultMutex(void) { return &mutexMethods; }

/* ------------------------------------------------------------------------- */
/* Glue for src/domains/sqlite/engine.ts                                      */

static int authorizer(void *context, int action, const char *a1, const char *a2,
                      const char *db, const char *trigger) {
  (void)context;
  return h_authorize(action, a1, a2, db, trigger);
}

/* moonrun sqlite/policy.rs `install_authorizer`, with the decision made by the host. */
EXPORT("mr_set_authorizer") int mr_set_authorizer(sqlite3 *db) {
  return sqlite3_set_authorizer(db, authorizer, 0);
}

static int progress(void *context) {
  (void)context;
  return h_progress();
}

/* Installs (or removes) the Job progress callback on `db`. */
EXPORT("mr_progress") void mr_progress(sqlite3 *db, int enable) {
  sqlite3_progress_handler(db, enable ? PROGRESS_OPS : 0, enable ? progress : 0, 0);
}

/* Bindings copy their value (SQLITE_TRANSIENT), as moonrun binds them. */
EXPORT("mr_bind_text16") int mr_bind_text16(sqlite3_stmt *s, int i, const void *v, int n) {
  return sqlite3_bind_text16(s, i, v, n, SQLITE_TRANSIENT);
}
EXPORT("mr_bind_blob") int mr_bind_blob(sqlite3_stmt *s, int i, const void *v, int n) {
  return sqlite3_bind_blob(s, i, v, n, SQLITE_TRANSIENT);
}

/* UTF-16 code units before the NUL. */
EXPORT("mr_utf16_length") int mr_utf16_length(const unsigned short *p) {
  int n = 0;
  while (p[n]) n++;
  return n;
}

EXPORT("mr_malloc") void *mr_malloc(int n) { return malloc(n); }
EXPORT("mr_free") void mr_free(void *p) { free(p); }

/* compiler-rt's __multi3 (clang's wasm32 builtins are not part of the toolchain). */
typedef unsigned long long u64;
typedef unsigned __int128 u128;
static u64 mulhi(u64 a, u64 b, u64 *lo) {
  u64 a0 = (unsigned)a, a1 = a >> 32, b0 = (unsigned)b, b1 = b >> 32;
  u64 p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  u64 mid = (p00 >> 32) + (unsigned)p01 + (unsigned)p10;
  *lo = (mid << 32) | (unsigned)p00;
  return p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
}
__int128 __multi3(__int128 a, __int128 b) {
  u64 al = (u64)a, ah = (u64)((u128)a >> 64), bl = (u64)b, bh = (u64)((u128)b >> 64);
  u64 lo;
  u64 hi = mulhi(al, bl, &lo);
  hi += al * bh + ah * bl;
  return (__int128)(((u128)hi << 64) | lo);
}
