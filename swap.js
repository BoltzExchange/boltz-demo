import zkpInit from "@vulpemventures/secp256k1-zkp";
import axios from "axios";
import {
  Transaction,
  address,
  crypto,
  initEccLib,
  networks,
} from "bitcoinjs-lib";
import {
  Musig,
  OutputType,
  SwapTreeSerializer,
  TaprootUtils,
  constructClaimTransaction,
  detectSwap,
  targetFee,
} from "boltz-core";
import { randomBytes } from "crypto";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import ws from "ws";

// Endpoint of the Boltz instance to be used
const endpoint = "https://api.testnet.boltz.exchange";

// Amount you want to swap
const invoiceAmount = 50_000;

// Address to which the swap should be claimed
const destinationAddress =
  "tb1pfjh36n5ksntze6dnzlexy2slda4uzx5z7pkrrs8shnd3k9hrtnss7dwgwh";

const network = networks.testnet;

const reverseSwap = async () => {
  initEccLib(ecc);

  // Create a random preimage for the swap; has to have a length of 32 bytes
  const preimage = randomBytes(32);
  const keys = ECPairFactory(ecc).makeRandom();

  // Create a Submarine Swap
  const createdResponse = (
    await axios.post(`${endpoint}/v2/swap/reverse`, {
      invoiceAmount,
      to: "BTC",
      from: "BTC",
      claimPublicKey: keys.publicKey.toString("hex"),
      preimageHash: crypto.sha256(preimage).toString("hex"),
    })
  ).data;

  console.log("Created swap");
  console.log(createdResponse);
  console.log();

  // Create a WebSocket and subscribe to updates for the created swap
  const webSocket = new ws(`${endpoint.replace("http://", "ws://")}/v2/ws`);
  webSocket.on("open", () => {
    webSocket.send(
      JSON.stringify({
        op: "subscribe",
        channel: "swap.update",
        args: [createdResponse.id],
      })
    );
  });

  webSocket.on("message", async (rawMsg) => {
    const msg = JSON.parse(rawMsg.toString("utf-8"));
    if (msg.event !== "update") {
      return;
    }

    console.log("Got WebSocket update");
    console.log(msg);
    console.log();

    switch (msg.args[0].status) {
      // "swap.created" means Boltz is waiting for the invoice to be paid
      case "swap.created": {
        console.log("Waiting invoice to be paid");
        break;
      }

      // "transaction.mempool" means that Boltz send an onchain transaction
      case "transaction.mempool": {
        console.log("Creating claim transaction");

        // TODO: imeplement me

        break;
      }

      case "invoice.settled":
        console.log("Swap successful");
        webSocket.close();
        break;
    }
  });
};

(async () => {
  await reverseSwap();
})();
