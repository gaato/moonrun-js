//! Test-only component: upstream `filesystem/job/stat.rs` (the generic stat layout),
//! verbatim. `test/unit/stat-layout.test.ts` compares `src/kernel/fs-codec.ts` with it.
#![allow(dead_code, unused_imports)]

pub(crate) use ::os;

/// The two items stat.rs names from async_host/mod.rs (OS-bound).
mod async_host {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum AsyncHostError {
        Fault,
        Inval,
        Io,
        Badf,
        PermissionDenied,
        Native(i32),
    }
    pub(crate) type AsyncHostResult<T> = Result<T, AsyncHostError>;
}

/// Stand-in for crate::resource (OS-bound): only what `run_fstatx_job`/`run_statx_job` name.
mod resource {
    use crate::async_host::{AsyncHostError, AsyncHostResult};

    pub(crate) struct Fd(i32);

    impl crate::os::fd::AsRawFd for Fd {
        fn as_raw_fd(&self) -> i32 {
            self.0
        }
    }

    pub(crate) struct Resource;

    impl Resource {
        pub(crate) fn as_file(&self) -> AsyncHostResult<Fd> {
            Err(AsyncHostError::Badf)
        }
    }
}

mod filesystem {
    pub(crate) mod job {
        #[path = "../../../upstream/crates/moonrun/src/filesystem/job/stat.rs"]
        pub(crate) mod stat;

        use stat::{PackedStat, StatRequest, StatTimestamp, StatValues};

        /// `PackedStat::new(StatRequest::new(mask, capacity)?, values)`. `values` are 12 i64:
        /// kind, size, device, inode, then (seconds, nanoseconds) for access, modify, change,
        /// create; bit i of `present` says whether property i is known. Returns the encoded
        /// length written to `out`, or -1 when the request is invalid.
        ///
        /// # Safety
        /// `values` must point to 12 i64 and `out` to `capacity` bytes.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn stat_pack(mask: u32, capacity: u32, present: u32, values: *const i64, out: *mut u8) -> i32 {
            let Ok(request) = StatRequest::new(mask, capacity) else {
                return -1;
            };
            let v = unsafe { std::slice::from_raw_parts(values, 12) };
            let has = |bit: u32| present & (1 << bit) != 0;
            let time = |bit: u32, i: usize| {
                has(bit).then_some(StatTimestamp { seconds: v[i], nanoseconds: v[i + 1] })
            };
            let packed = PackedStat::new(
                request,
                StatValues {
                    kind: has(0).then_some(v[0] as i32),
                    size: has(1).then_some(v[1]),
                    device_id: has(2).then_some(v[2] as u64),
                    file_id: has(3).then_some(v[3] as u64),
                    access_time: time(4, 4),
                    modify_time: time(5, 6),
                    change_time: time(6, 8),
                    create_time: time(7, 10),
                },
            );
            let bytes = packed.as_bytes();
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
            bytes.len() as i32
        }
    }
}
