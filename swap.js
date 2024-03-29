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
  console.log(JSON.stringify({
    id: createdResponse.id,
    onchainAmount: createdResponse.onchainAmount,
    invoice: createdResponse.invoice,
  }, undefined, 2));
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

    console.log();
    console.log("-----");
    console.log("Got WebSocket update");
    console.log(JSON.stringify(msg.args[0], undefined, 2));
    console.log("-----");
    console.log();

    switch (msg.args[0].status) {
      // "swap.created" means Boltz is waiting for the invoice to be paid
      case "swap.created": {
        console.log("Waiting invoice to be paid");
        break;
      }

      // "transaction.mempool" means that Boltz send an onchain transaction
      case "transaction.mempool": {
        const boltzPublicKey = Buffer.from(
          createdResponse.refundPublicKey,
          "hex"
        );

        // Create a musig signing session and tweak it with the Taptree of the swap scripts
        const musig = new Musig(await zkpInit.default(), keys, randomBytes(32), [
          boltzPublicKey,
          keys.publicKey,
        ]);
        const tweakedKey = TaprootUtils.tweakMusig(
          musig,
          SwapTreeSerializer.deserializeSwapTree(createdResponse.swapTree).tree
        );

        // Parse the lockup transaction and find the output relevant for the swap
        const lockupTx = Transaction.fromHex(msg.args[0].transaction.hex);
        console.log(`Got lockup transaction: ${lockupTx.getId()}`);

        const swapOutput = detectSwap(tweakedKey, lockupTx);
        if (swapOutput === undefined) {
          console.error("No swap output found in lockup transaction");
          return;
        }

        console.log("Creating claim transaction");

        // Create a claim transaction to be signed cooperatively via a key path spend
        const claimTx = targetFee(2, (fee) =>
          constructClaimTransaction(
            [
              {
                ...swapOutput,
                keys,
                preimage,
                cooperative: true,
                type: OutputType.Taproot,
                txHash: lockupTx.getHash(),
              },
            ],
            address.toOutputScript(destinationAddress, network),
            fee
          )
        );

        // Get the partial signature from Boltz
        const boltzSig = (
          await axios.post(
            `${endpoint}/v2/swap/reverse/${createdResponse.id}/claim`,
            {
              index: 0,
              transaction: claimTx.toHex(),
              preimage: preimage.toString("hex"),
              pubNonce: Buffer.from(musig.getPublicNonce()).toString("hex"),
            }
          )
        ).data;

        // Aggregate the nonces
        musig.aggregateNonces([
          [boltzPublicKey, Buffer.from(boltzSig.pubNonce, "hex")],
        ]);

        // Initialize the session to sign the claim transaction
        musig.initializeSession(
          claimTx.hashForWitnessV1(
            0,
            [swapOutput.script],
            [swapOutput.value],
            Transaction.SIGHASH_DEFAULT
          )
        );

        // Add the partial signature from Boltz
        musig.addPartial(
          boltzPublicKey,
          Buffer.from(boltzSig.partialSignature, "hex")
        );

        // Create our partial signature
        musig.signPartial();

        // Witness of the input to the aggregated signature
        claimTx.ins[0].witness = [musig.aggregatePartials()];

        // Broadcast the finalized transaction
        await axios.post(`${endpoint}/v2/chain/BTC/transaction`, {
          hex: claimTx.toHex(),
        });

        break;
      }

      case "invoice.settled":
        console.log();
        console.log("Swap successful!");
        webSocket.close();
        break;
    }
  });
};

(async () => {
  await reverseSwap();
})();
