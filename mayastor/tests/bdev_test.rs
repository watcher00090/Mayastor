use once_cell::sync::OnceCell;

pub mod common;
use common::compose::{Builder, ComposeTest, MayastorTest};

use mayastor::{
    bdev::{nexus_create, nexus_lookup},
    core::{
        io_driver,
        io_driver::JobQueue,
        Bdev,
        MayastorCliArgs,
        SIG_RECEIVED,
    },
};
use rpc::mayastor::{BdevShareRequest, BdevUri, CreateReply};
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

static MAYASTOR: OnceCell<MayastorTest> = OnceCell::new();
static DOCKER_COMPOSE: OnceCell<ComposeTest> = OnceCell::new();
// this functions runs with in the context of the mayastorTest instance
async fn create_work(queue: Arc<JobQueue>) {
    // get a vector of grpc clients to all containers that are part of this test
    let mut hdls = DOCKER_COMPOSE.get().unwrap().grpc_handles().await.unwrap();

    // for each grpc client, invoke these methods.
    for h in &mut hdls {
        // create the bdev
        h.bdev
            .create(BdevUri {
                uri: "malloc:///disk0?size_mb=100".into(),
            })
            .await
            .unwrap();
        // share it over nvmf
        h.bdev
            .share(BdevShareRequest {
                name: "disk0".into(),
                proto: "nvmf".into(),
            })
            .await
            .unwrap();
    }

    // get a reference to mayastor (used later)
    let ms = MAYASTOR.get().unwrap();

    // have ms create our nexus to the targets created above to know the IPs of
    // the mayastor instances that run in the container, the handles can be
    // used. This avoids hardcoded IPs and having magic constants.
    ms.spawn(async move {
        nexus_create(
            "nexus0",
            1024 * 1024 * 50,
            None,
            &[
                format!(
                    "nvmf://{}:8420/nqn.2019-05.io.openebs:disk0",
                    hdls[0].endpoint.ip()
                ),
                format!(
                    "nvmf://{}:8420/nqn.2019-05.io.openebs:disk0",
                    hdls[1].endpoint.ip()
                ),
            ],
        )
        .await
        .unwrap();

        let bdev = Bdev::lookup_by_name("nexus0").unwrap();

        // create a job using the bdev we looked up, we are in the context here
        // of the ms instance and not the containers.
        let job = io_driver::Builder::new()
            .core(1)
            .bdev(bdev)
            .qd(64)
            .io_size(512)
            .build()
            .await;

        // start the first job
        queue.start(job);

        // create a new job and start it. Note that the malloc bdev is created
        // implicitly with the uri() argument
        let job = io_driver::Builder::new()
            .core(0)
            .uri("malloc:///disk0?size_mb=100")
            .qd(64)
            .io_size(512)
            .build()
            .await;

        queue.start(job);
    })
    .await
}

async fn clean_up(queue: Arc<JobQueue>) {
    let ms = MAYASTOR.get().unwrap();
    queue.stop_all().await;
    ms.spawn(nexus_lookup("nexus0").unwrap().destroy())
        .await
        .unwrap();
    // now we manually destroy the docker containers
}

async fn pause_tgt() {
    let t = DOCKER_COMPOSE.get().unwrap();
    let mut hdl = t.grpc_handle("ms1").await;
    hdl.bdev
        .unshare(CreateReply {
            name: "disk0".to_string(),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn nvmf_bdev_test() {
    let queue = Arc::new(JobQueue::new());

    // create the docker containers
    let compose = Builder::new()
        .name("cargo-test")
        .network("10.1.0.0/16")
        .add_container("ms1")
        .add_container("ms2")
        .with_clean(true)
        .with_prune(true)
        .build()
        .await
        .unwrap();

    // create the mayastor test instance
    let ms = MayastorTest::new(MayastorCliArgs {
        log_components: vec!["all".into()],
        reactor_mask: "0x3".to_string(),
        no_pci: true,
        grpc_endpoint: "0.0.0.0".to_string(),
        ..Default::default()
    });

    DOCKER_COMPOSE.set(compose).unwrap();

    let ms = MAYASTOR.get_or_init(|| ms);

    create_work(Arc::clone(&queue)).await;
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    for _i in 1 .. 100 {
        ticker.tick().await;
        ms.spawn(async move {
            let bdev = Bdev::bdev_first().unwrap().into_iter();
            for b in bdev {
                let result = b.stats().await.unwrap();
                println!("{}: {:?}", b.name(), result);
            }
        })
        .await;

        if SIG_RECEIVED.load(Ordering::Relaxed) {
            break;
        }
    }

    queue.stop_all().await;
    ms.spawn(nexus_lookup("nexus0").unwrap().destroy())
        .await
        .unwrap();
    // now we manually destroy the docker containers
    DOCKER_COMPOSE.get().unwrap().down().await;
}
