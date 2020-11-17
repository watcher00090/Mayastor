use once_cell::sync::OnceCell;

pub mod common;
use common::compose::{Builder, ComposeTest, MayastorTest, RpcHandle};

use mayastor::{
    core::{
        io_driver,
        io_driver::JobQueue,
        Bdev,
        Cores,
        MayastorCliArgs,
        SIG_RECEIVED,
    },
    nexus_uri::bdev_create,
};
use rpc::mayastor::{
    BdevShareRequest,
    BdevUri,
    CreateNexusRequest,
    CreateReply,
};
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

static MAYASTOR: OnceCell<MayastorTest> = OnceCell::new();
static DOCKER_COMPOSE: OnceCell<ComposeTest> = OnceCell::new();

async fn create_target(container: &str) -> String {
    let mut h = DOCKER_COMPOSE.get().unwrap().grpc_handle(container).await;
    h.bdev
        .create(BdevUri {
            uri: "malloc:///disk0?size_mb=100".into(),
        })
        .await
        .unwrap();
    // share it over nvmf
    let ep = h
        .bdev
        .share(BdevShareRequest {
            name: "disk0".into(),
            proto: "nvmf".into(),
        })
        .await
        .unwrap();

    ep.into_inner().uri
}

async fn create_nexus(container: &str, mut kiddos: Vec<String>) -> String {
    let mut h = DOCKER_COMPOSE.get().unwrap().grpc_handle(container).await;

    let bdev = h
        .bdev
        .create(BdevUri {
            uri: "malloc:///disk0?size_mb=100".into(),
        })
        .await
        .unwrap();

    kiddos.push(format!("bdev:///{}", bdev.into_inner().name));

    h.mayastor
        .create_nexus(CreateNexusRequest {
            uuid: "e46329bb-7e7a-480b-8b97-acc17fb31ba5".to_string(),
            size: 96 * 1024 * 1024,
            children: kiddos,
        })
        .await
        .unwrap();

    let endpoint = h
        .bdev
        .share(BdevShareRequest {
            name: "nexus-e46329bb-7e7a-480b-8b97-acc17fb31ba5".to_string(),
            proto: "nvmf".to_string(),
        })
        .await
        .unwrap();

    endpoint.into_inner().uri
}
async fn create_work(queue: Arc<JobQueue>) {
    let mut ticker = tokio::time::interval(Duration::from_millis(1000));

    let r1 = create_target("ms1").await;
    let r2 = create_target("ms2").await;
    let endpoint = create_nexus("ms3", vec![r1, r2]).await;
    // get a reference to mayastor (used later)
    let ms = MAYASTOR.get().unwrap();
    let bdev = ms
        .spawn(async move {
            let bdev = bdev_create(&endpoint).await.unwrap();
            bdev
        })
        .await;

    ticker.tick().await;

    ms.spawn(async move {
        for c in Cores::count() {
            let bdev = Bdev::lookup_by_name(&bdev).unwrap();
            let job = io_driver::Builder::new()
                .core(c)
                .bdev(bdev)
                .qd(64)
                .io_size(512)
                .build()
                .await;

            queue.start(job);
        }
    })
    .await;
}

async fn kill_replica(name: String) {
    let t = DOCKER_COMPOSE.get().unwrap();
    let mut hdl = t.grpc_handle(&name).await;

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
        .add_container("ms3")
        .with_clean(true)
        .with_prune(true)
        .build()
        .await
        .unwrap();

    let mask = format!("{:#01x}", (1 << 4) | (1 << 5));
    // create the mayastor test instance
    let ms = MayastorTest::new(MayastorCliArgs {
        log_components: vec!["all".into()],
        reactor_mask: mask,
        no_pci: true,
        grpc_endpoint: "0.0.0.0".to_string(),
        ..Default::default()
    });

    let mut ticker = tokio::time::interval(Duration::from_millis(1000));
    DOCKER_COMPOSE.set(compose).unwrap();

    let ms = MAYASTOR.get_or_init(|| ms);
    ticker.tick().await;
    create_work(Arc::clone(&queue)).await;
    for i in 1 .. 100 {
        ticker.tick().await;
        //
        // if i == 5 {
        //     kill_replica("ms1".into()).await;
        // }
        //
        // if i == 6 {
        //     kill_replica("ms2".into()).await;
        // }
        //
        ms.spawn(async move {
            let bdev = Bdev::bdev_first().unwrap().into_iter();
            for b in bdev {
                let result = b.stats().await.unwrap();
                println!("{}: {:?}", b.name(), result);
            }
        })
        .await;

        // ctrl was hit
        if SIG_RECEIVED.load(Ordering::Relaxed) {
            break;
        }
    }

    queue.stop_all().await;

    // // ctrl-c was hit do not destroy the nexus
    // if !SIG_RECEIVED.load(Ordering::Relaxed) {
    //     ms.spawn(nexus_lookup("nexus0").unwrap().destroy())
    //         .await
    //         .unwrap();
    // }

    ms.stop().await;
    // now we manually destroy the docker containers
    DOCKER_COMPOSE.get().unwrap().down().await;
}
